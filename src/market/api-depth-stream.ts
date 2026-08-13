import type { ApiClient } from "../api/index.ts"
import { DEPTH_STREAM_PATH, DEPTH_STREAM_TYPE, parseDepthUpdate } from "../api/market.ts"
import { StreamHttpError } from "../api/transport.ts"
import {
  DepthBookAccumulator,
  type DepthBookListener,
  type DepthStatus,
  type DepthStatusListener,
  type DepthStream,
} from "./depth.ts"

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 3000, 5000]

export interface ApiDepthStreamOptions {
  onError?: (error: unknown) => void
  reconnectDelaysMs?: number[]
}

type DepthStreamApiClient = Pick<ApiClient, "stream">

// Streams one symbol's order book. Only a single book is open at a time because
// the panel shows one instrument, so starting a new symbol replaces the old
// subscription; the generation counter keeps a retiring run from emitting into
// the new one.
export class ApiDepthStream implements DepthStream {
  private readonly listeners: DepthBookListener[] = []
  private readonly statusListeners: DepthStatusListener[] = []
  private readonly reconnectDelaysMs: number[]
  private readonly book = new DepthBookAccumulator()
  private controller: AbortController | null = null
  private symbol: string | null = null
  private generation = 0
  private running = false
  private status: DepthStatus = "idle"
  private attempt = 0

  constructor(
    private readonly client: DepthStreamApiClient,
    private readonly options: ApiDepthStreamOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  subscribe(listener: DepthBookListener): void {
    this.listeners.push(listener)
  }

  onStatusChange(listener: DepthStatusListener): void {
    this.statusListeners.push(listener)
  }

  start(symbol: string): void {
    const normalized = symbol.trim().toUpperCase()
    if (!normalized || (this.running && this.symbol === normalized)) return
    this.stop()
    this.symbol = normalized
    this.running = true
    this.attempt = 0
    this.notifyStatus("connecting")
    const generation = ++this.generation
    void this.run(normalized, generation)
  }

  stop(): void {
    this.running = false
    this.symbol = null
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.book.reset()
    this.notifyStatus("idle")
  }

  private async run(symbol: string, generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      const controller = new AbortController()
      this.controller = controller
      try {
        const frames = this.client.stream({
          path: DEPTH_STREAM_PATH,
          query: { symbol, type: DEPTH_STREAM_TYPE },
          signal: controller.signal,
        })
        for await (const frame of frames) {
          if (!this.running || this.generation !== generation) break
          const update = parseDepthUpdate(frame.data)
          if (!update || update.symbol.toUpperCase() !== symbol) continue
          this.attempt = 0
          this.notifyStatus("live")
          const book = this.book.apply(update)
          for (const listener of this.listeners) listener(book)
        }
      } catch (error) {
        if (!this.running || this.generation !== generation || controller.signal.aborted) break
        // A missing or forbidden book is a property of the symbol and the
        // member's entitlements, not a dropped connection: reconnecting would
        // just fail the same way, so settle on "unavailable" instead.
        if (isPermanentDepthError(error)) {
          this.notifyStatus("unavailable")
          this.running = false
          break
        }
        this.options.onError?.(error)
      } finally {
        if (this.generation === generation && this.running) this.notifyStatus("connecting")
      }
      if (!this.running || this.generation !== generation) break
      await this.backoff(controller.signal)
    }
  }

  private notifyStatus(status: DepthStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
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

function isPermanentDepthError(error: unknown): boolean {
  return error instanceof StreamHttpError && (error.status === 403 || error.status === 404)
}
