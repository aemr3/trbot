import type { ConnectionListener, QuoteStream, QuoteUpdateListener } from "@trbot/market/quote-stream.ts"
import { FEED_FIELDS, QUOTE_FIELDS, topic } from "./fields.ts"
import type { FieldUpdate, SocketSubscriber } from "./socket.ts"
import { sessionStatus } from "./session-hours.ts"
import { asNumber } from "./value.ts"

interface QuoteState {
  lastPrice: number | null
  ask: number | null
  bid: number | null
  /** The feed's raw session code, which only two values are known for. */
  statusCode: number | null
  timestamp: number | null
}

export interface FeedQuoteStreamOptions {
  now?: () => number
  onLicenseTaken?: () => void
  /**
   * The symbol's trading hours. Open and closed are read from these rather than
   * from the feed's session code, which is undocumented beyond two values.
   */
  sessionFor?: (symbol: string) => string | null
}

/**
 * Live quotes over the shared realtime socket.
 *
 * The feed pushes one field at a time rather than whole quotes, so the last
 * known values are held per symbol and a complete update is emitted on every
 * delta. Without that, a lone bid tick would publish a quote whose price is null
 * and blank the price a rule is watching.
 */
export class FeedQuoteStream implements QuoteStream {
  private readonly listeners: QuoteUpdateListener[] = []
  private readonly connectionListeners: ConnectionListener[] = []
  private readonly states = new Map<string, QuoteState>()
  private readonly now: () => number
  private release: (() => void) | null = null
  private symbols: string[] = []

  constructor(
    private readonly socket: SocketSubscriber,
    private readonly options: FeedQuoteStreamOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
  }

  subscribe(listener: QuoteUpdateListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: ConnectionListener): void {
    this.connectionListeners.push(listener)
  }

  /**
   * Subscribes to `symbols`, resubscribing when the set changes. Positions a
   * trader is protecting can sit outside the watchlist, so this is called again
   * as holdings change; an identical set is ignored so that costs nothing.
   */
  start(symbols: string[]): void {
    if (symbols.length === 0) return
    const wanted = [...new Set(symbols)].sort()
    if (this.release && sameSymbols(this.symbols, wanted)) return
    this.symbols = wanted

    const topics = wanted.flatMap((symbol) => QUOTE_FIELDS.map((field) => topic(symbol, field)))
    this.release?.()
    this.states.clear()
    this.release = this.socket.subscribe(topics, {
      onFields: (updates) => this.applyFields(updates),
      onConnectionChange: (connected) => this.notifyConnection(connected),
      onLicenseTaken: () => this.options.onLicenseTaken?.(),
    })
  }

  stop(): void {
    this.release?.()
    this.release = null
    this.symbols = []
    this.states.clear()
  }

  private applyFields(updates: FieldUpdate[]): void {
    const touched = new Set<string>()
    for (const update of updates) {
      const state = this.states.get(update.symbol) ?? {
        lastPrice: null,
        ask: null,
        bid: null,
        statusCode: null,
        timestamp: null,
      }
      switch (update.field) {
        case FEED_FIELDS.CLOSE:
          state.lastPrice = asNumber(update.value)
          break
        case FEED_FIELDS.ASK:
          state.ask = asNumber(update.value)
          break
        case FEED_FIELDS.BID:
          state.bid = asNumber(update.value)
          break
        case FEED_FIELDS.STATUS:
          state.statusCode = asNumber(update.value)
          break
        case FEED_FIELDS.TIMESTAMP:
          state.timestamp = asNumber(update.value)
          break
        default:
          // Other subscribed fields carry no part of a quote.
          continue
      }
      this.states.set(update.symbol, state)
      touched.add(update.symbol)
    }

    for (const symbol of touched) {
      const state = this.states.get(symbol)
      if (!state) continue
      const now = this.now()
      const update = {
        symbol,
        lastPrice: state.lastPrice,
        ask: state.ask,
        bid: state.bid,
        sessionStatus: sessionStatus(this.options.sessionFor?.(symbol) ?? null, state.statusCode, now),
        // The feed's own clock is in seconds and only present on some frames, so
        // fall back to arrival time rather than publishing a quote with none.
        timestamp: state.timestamp === null ? now : state.timestamp * 1000,
      }
      for (const listener of this.listeners) listener(update)
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected)
  }
}

function sameSymbols(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index])
}
