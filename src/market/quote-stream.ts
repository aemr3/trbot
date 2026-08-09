import type { ApiClient } from "../api/index.ts"
import { parseFuturePriceUpdate, VIOP_PRICE_STREAM_EVENT, VIOP_PRICE_STREAM_PATH } from "../api/market.ts"

export interface QuoteUpdate {
  symbol: string
  lastPrice: number | null
  ask?: number | null
  bid?: number | null
  sessionStatus: string | null
  timestamp: number
}

export type QuoteUpdateListener = (update: QuoteUpdate) => void

export type ConnectionListener = (connected: boolean) => void

export interface QuoteStream {
  subscribe(listener: QuoteUpdateListener): void
  // Fires true once live price frames are flowing on a connection and false
  // when it drops — "live" means real ticks, not merely an open socket.
  onConnectionChange(listener: ConnectionListener): void
  start(symbols: string[]): void
  stop(): void
}

export interface ApiQuoteStreamOptions {
  onError?: (error: unknown) => void
  reconnectDelaysMs?: number[]
}

type QuoteStreamApiClient = Pick<ApiClient, "stream">

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 3000, 5000]

// Streams live VIOP futures prices over SSE and re-connects with backoff. The
// provider closes idle streams and rotates tokens, so a dropped connection is
// expected: reconnecting re-authenticates through the client and resubscribes.
export class ApiQuoteStream implements QuoteStream {
  private readonly listeners: QuoteUpdateListener[] = []
  private readonly connectionListeners: ConnectionListener[] = []
  private readonly reconnectDelaysMs: number[]
  private controller: AbortController | null = null
  private running = false
  private connected = false
  private symbols: string[] = []
  private attempt = 0

  constructor(
    private readonly client: QuoteStreamApiClient,
    private readonly options: ApiQuoteStreamOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  subscribe(listener: QuoteUpdateListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: ConnectionListener): void {
    this.connectionListeners.push(listener)
  }

  start(symbols: string[]): void {
    if (this.running || symbols.length === 0) return
    this.running = true
    this.symbols = symbols
    void this.run()
  }

  stop(): void {
    this.running = false
    this.controller?.abort()
    this.controller = null
  }

  private async run(): Promise<void> {
    while (this.running) {
      const controller = new AbortController()
      this.controller = controller
      try {
        const frames = this.client.stream({
          path: VIOP_PRICE_STREAM_PATH,
          query: { symbol: this.symbols.join(",") },
          signal: controller.signal,
        })
        for await (const frame of frames) {
          if (!this.running) break
          if (frame.event && frame.event !== VIOP_PRICE_STREAM_EVENT) continue
          const update = parseFuturePriceUpdate(frame.data)
          if (!update) continue
          this.notifyConnection(true)
          for (const listener of this.listeners) {
            listener({
              symbol: update.symbol,
              lastPrice: update.lastPrice,
              ask: update.ask,
              bid: update.bid,
              sessionStatus: update.sessionStatus,
              timestamp: update.timestamp,
            })
          }
        }
      } catch (error) {
        if (this.running && !controller.signal.aborted) this.options.onError?.(error)
      } finally {
        this.notifyConnection(false)
      }
      if (!this.running) break
      await this.backoff(controller.signal)
    }
  }

  // "Connected" tracks live price flow, so it flips true only after a real tick
  // is parsed and false when the connection ends. Backoff resets on a good tick.
  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    if (connected) this.attempt = 0
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
