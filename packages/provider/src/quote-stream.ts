import type { ApiClient } from "@trbot/api"
import { parseFuturePriceUpdate, VIOP_PRICE_STREAM_EVENT, VIOP_PRICE_STREAM_PATH } from "@trbot/api/market.ts"
import type { ConnectionListener, QuoteStream, QuoteUpdateListener } from "@trbot/market/quote-stream.ts"

export interface ApiQuoteStreamOptions {
  onError?: (cause: unknown) => void
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
  // Identifies the current subscription, so a resubscribe retires the old loop.
  private generation = 0

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

  /**
   * Subscribes to `symbols`. Calling it again with a different set resubscribes
   * — positions the trader protects can sit outside the watchlist, and the
   * provider takes the symbol list only when the stream opens. An identical set
   * is ignored so a repeated call costs nothing.
   */
  start(symbols: string[]): void {
    if (symbols.length === 0) return
    const wanted = [...new Set(symbols)].sort()
    if (this.running && sameSymbols(this.symbols, wanted)) return
    this.symbols = wanted
    // A retiring run must not emit into the new subscription: bumping the
    // generation ends the old loop, and a fresh one carries the new symbols.
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.running = true
    void this.run(this.generation)
  }

  stop(): void {
    this.running = false
    this.generation += 1
    this.controller?.abort()
    this.controller = null
  }

  private async run(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      const controller = new AbortController()
      this.controller = controller
      try {
        const frames = this.client.stream({
          path: VIOP_PRICE_STREAM_PATH,
          query: { symbol: this.symbols.join(",") },
          signal: controller.signal,
        })
        for await (const frame of frames) {
          if (!this.running || generation !== this.generation) break
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

function sameSymbols(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index])
}
