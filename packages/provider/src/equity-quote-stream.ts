import type { ApiClient } from "@trbot/api"
import type { EquityQuoteListener, EquityQuoteStream, EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import { z } from "zod"

const EQUITY_PRICE_STREAM_PATH = "/reactive-market-api/v1/instruments/trade-price/stream"
const EQUITY_PRICE_STREAM_EVENT = "Ticker"
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 3000, 5000]

export interface ApiEquityQuoteStreamOptions {
  onError?: (cause: unknown) => void
  reconnectDelaysMs?: number[]
}

type EquityStreamApiClient = Pick<ApiClient, "stream">

export class ApiEquityQuoteStream implements EquityQuoteStream {
  private readonly listeners: EquityQuoteListener[] = []
  private readonly connectionListeners: ((connected: boolean) => void)[] = []
  private readonly reconnectDelaysMs: number[]
  private controller: AbortController | null = null
  private symbol: string | null = null
  private generation = 0
  private running = false
  private connected = false
  private attempt = 0

  constructor(
    private readonly client: EquityStreamApiClient,
    private readonly options: ApiEquityQuoteStreamOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  subscribe(listener: EquityQuoteListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener)
  }

  start(symbol: string): void {
    const normalized = symbol.trim().toUpperCase()
    if (!normalized || (this.running && this.symbol === normalized)) return
    this.stop()
    this.symbol = normalized
    this.running = true
    this.attempt = 0
    const generation = ++this.generation
    void this.run(normalized, generation)
  }

  stop(): void {
    this.running = false
    this.symbol = null
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.notifyConnection(false)
  }

  private async run(symbol: string, generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      const controller = new AbortController()
      this.controller = controller
      try {
        const frames = this.client.stream({
          path: EQUITY_PRICE_STREAM_PATH,
          query: { TR: symbol, overnightEnabled: "true" },
          signal: controller.signal,
        })
        for await (const frame of frames) {
          if (!this.running || this.generation !== generation) break
          if (frame.event && frame.event !== EQUITY_PRICE_STREAM_EVENT) continue
          for (const update of parseEquityQuoteUpdates(frame.data)) {
            if (update.symbol !== symbol) continue
            this.notifyConnection(true)
            this.attempt = 0
            for (const listener of this.listeners) listener(update)
          }
        }
      } catch (error) {
        if (this.running && this.generation === generation && !controller.signal.aborted) this.options.onError?.(error)
      } finally {
        if (this.generation === generation) this.notifyConnection(false)
      }
      if (!this.running || this.generation !== generation) break
      await this.backoff(controller.signal)
    }
  }

  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const listener of this.connectionListeners) listener(connected)
  }

  private backoff(signal: AbortSignal): Promise<void> {
    const index = Math.min(this.attempt, this.reconnectDelaysMs.length - 1)
    this.attempt++
    const delay = this.reconnectDelaysMs[index] ?? 0
    return new Promise<void>((resolve) => {
      if (delay <= 0 || signal.aborted) return resolve()
      const timer = setTimeout(resolve, delay)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}

export function parseEquityQuoteUpdates(data: string): EquityQuoteUpdate[] {
  let decoded: z.input<typeof EquityQuoteFramesSchema>
  try {
    decoded = JSON.parse(data)
  } catch {
    return []
  }
  const parsed = EquityQuoteFramesSchema.safeParse(decoded)
  if (!parsed.success) return []

  return parsed.data.flatMap((raw): EquityQuoteUpdate[] => {
    if (raw.c !== "TR") return []
    return [{
      symbol: raw.s.toUpperCase(),
      lastPrice: raw.p,
      timestamp: raw.t < 1_000_000_000_000 ? raw.t * 1000 : raw.t,
      sessionStatus: raw.ss ?? null,
    }]
  })
}

const FiniteNumberSchema = z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite)
const EquityQuoteFramesSchema = z.array(z.object({
  c: z.string(),
  p: FiniteNumberSchema,
  s: z.string(),
  ss: z.string().nullable().catch(null).optional(),
  t: FiniteNumberSchema,
})).catch([])
