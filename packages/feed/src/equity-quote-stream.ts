import type { EquityQuoteListener, EquityQuoteStream, EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import { FEED_FIELDS, topic } from "./fields.ts"
import type { FieldUpdate, SocketSubscriber } from "./socket.ts"
import { sessionStatus } from "./session-hours.ts"
import { asNumber } from "./value.ts"

const FIELDS = [FEED_FIELDS.CLOSE, FEED_FIELDS.STATUS, FEED_FIELDS.TIMESTAMP]

export interface FeedEquityQuoteStreamOptions {
  now?: () => number
  onLicenseTaken?: () => void
  /** The symbol's trading hours; see FeedQuoteStream for why the code is not used. */
  sessionFor?: (symbol: string) => string | null
}

/**
 * One equity's last price, over the shared realtime socket.
 *
 * This contract carries a non-null price, so a frame that clears the price or
 * only moves the session status publishes nothing rather than inventing a zero.
 */
export class FeedEquityQuoteStream implements EquityQuoteStream {
  private readonly listeners: EquityQuoteListener[] = []
  private readonly connectionListeners: ((connected: boolean) => void)[] = []
  private readonly now: () => number
  private symbol: string | null = null
  private release: (() => void) | null = null
  private lastPrice: number | null = null
  private statusCode: number | null = null
  private timestamp: number | null = null

  constructor(
    private readonly socket: SocketSubscriber,
    private readonly options: FeedEquityQuoteStreamOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
  }

  subscribe(listener: EquityQuoteListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener)
  }

  start(symbol: string): void {
    if (this.symbol === symbol && this.release) return
    this.stop()
    this.symbol = symbol
    this.release = this.socket.subscribe(FIELDS.map((field) => topic(symbol, field)), {
      onFields: (updates) => this.apply(updates),
      onConnectionChange: (connected) => {
        for (const listener of this.connectionListeners) listener(connected)
      },
      onLicenseTaken: () => this.options.onLicenseTaken?.(),
    })
  }

  stop(): void {
    this.release?.()
    this.release = null
    this.symbol = null
    this.lastPrice = null
    this.statusCode = null
    this.timestamp = null
  }

  private apply(updates: FieldUpdate[]): void {
    const symbol = this.symbol
    if (!symbol) return
    let changed = false
    for (const update of updates) {
      if (update.symbol !== symbol) continue
      switch (update.field) {
        case FEED_FIELDS.CLOSE:
          this.lastPrice = asNumber(update.value)
          changed = true
          break
        case FEED_FIELDS.STATUS:
          this.statusCode = asNumber(update.value)
          changed = true
          break
        case FEED_FIELDS.TIMESTAMP:
          this.timestamp = asNumber(update.value)
          break
        default:
          continue
      }
    }

    const price = this.lastPrice
    if (!changed || price === null) return
    const now = this.now()
    const quote: EquityQuoteUpdate = {
      symbol,
      lastPrice: price,
      timestamp: this.timestamp === null ? now : this.timestamp * 1000,
      sessionStatus: sessionStatus(this.options.sessionFor?.(symbol) ?? null, this.statusCode, now),
    }
    for (const listener of this.listeners) listener(quote)
  }
}
