import {
  averageTrueRange,
  closedCandles,
  rangeForInterval,
  type Candle,
  type CandleInterval,
  type CandleSource,
} from "./candle.ts"
import type { QuoteUpdate } from "./quote-stream.ts"

const DEFAULT_STALE_PRICE_MS = 20_000
const STALE_CANDLE_MS = 90_000
const ATR_PERIOD = 14

export type LevelMonitorFeedState = "live" | "stale" | "missing"

export interface LevelMonitorSample {
  price: number
  timestamp: number
}

export interface RecordedQuote extends LevelMonitorSample {
  observedAt: number
}

export interface LevelMonitorTarget {
  symbol: string
  instrumentUid: string
  interval: CandleInterval | null
  basis: "TOUCH" | "CLOSE"
}

export interface CandleTarget {
  instrumentUid: string
  interval: CandleInterval
}

export interface CandleReading extends CandleTarget {
  lastClosed: Candle | null
  atr: number | null
  now: number
}

export interface LevelMonitorFeedOptions {
  candles?: CandleSource
  stalePriceMs?: number
  now?: () => number
  onError?: (cause: unknown) => void
}

export interface LevelMonitorFeedView {
  level: number | null
  lastPrice: number | null
  distancePercent: number | null
  feed: LevelMonitorFeedState
}

/** Shared quote freshness and candle polling for market level monitors. */
export class LevelMonitorFeed {
  private readonly quotes = new Map<string, LevelMonitorSample>()
  private readonly candles = new Map<string, LevelMonitorSample>()
  private candleRequest: AbortController | null = null
  private stopped = false

  constructor(private readonly options: LevelMonitorFeedOptions) {}

  get destroyed(): boolean {
    return this.stopped
  }

  now(): number {
    return this.options.now?.() ?? Date.now()
  }

  recordQuote(update: QuoteUpdate): RecordedQuote | null {
    if (this.stopped || update.lastPrice === null || !Number.isFinite(update.lastPrice)) return null
    const observedAt = this.now()
    const sample = {
      price: update.lastPrice,
      timestamp: Math.min(update.timestamp, observedAt),
      observedAt,
    }
    this.quotes.set(update.symbol, sample)
    return sample
  }

  quote(symbol: string): LevelMonitorSample | undefined {
    return this.quotes.get(symbol)
  }

  view(
    target: LevelMonitorTarget,
    level: number | null,
    now: number,
  ): LevelMonitorFeedView {
    const fromCandles = target.basis === "CLOSE"
    const sample = fromCandles
      ? this.candles.get(candleKey(target.instrumentUid, target.interval))
      : this.quotes.get(target.symbol)
    const lastPrice = sample?.price ?? null
    return {
      level,
      lastPrice,
      distancePercent: level !== null && lastPrice !== null && lastPrice > 0
        ? ((level - lastPrice) / lastPrice) * 100
        : null,
      feed: sampleState(sample, now, fromCandles ? STALE_CANDLE_MS : this.stalePriceMs()),
    }
  }

  quoteState(symbol: string, now: number): LevelMonitorFeedState {
    return sampleState(this.quotes.get(symbol), now, this.stalePriceMs())
  }

  quoteAgeMs(symbol: string, now: number): number {
    return Math.max(0, now - (this.quotes.get(symbol)?.timestamp ?? now))
  }

  async refreshCandles(
    targets: Iterable<CandleTarget>,
    apply: (reading: CandleReading) => boolean,
  ): Promise<boolean> {
    const source = this.options.candles
    if (!source || this.stopped) return false

    this.candleRequest?.abort()
    const request = new AbortController()
    this.candleRequest = request
    try {
      let changed = false
      for (const { instrumentUid, interval } of targets) {
        const series = await source.loadCandles(instrumentUid, rangeForInterval(interval), interval, {
          signal: request.signal,
          target: "INSTRUMENT",
        })
        if (this.stopped || request.signal.aborted || this.candleRequest !== request) return false
        const now = this.now()
        const closed = closedCandles(series, now)
        const lastClosed = closed.at(-1) ?? null
        if (lastClosed) {
          this.candles.set(candleKey(instrumentUid, interval), { price: lastClosed.close, timestamp: now })
          changed = true
        }
        changed = apply({
          instrumentUid,
          interval,
          lastClosed,
          atr: averageTrueRange(closed, ATR_PERIOD),
          now,
        }) || changed
      }
      return changed
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) return false
      this.report(error)
      return false
    } finally {
      if (this.candleRequest === request) this.candleRequest = null
    }
  }

  report(cause: unknown): void {
    if (!this.stopped) this.options.onError?.(cause)
  }

  destroy(): void {
    this.stopped = true
    this.candleRequest?.abort()
    this.candleRequest = null
  }

  private stalePriceMs(): number {
    return this.options.stalePriceMs ?? DEFAULT_STALE_PRICE_MS
  }
}

function candleKey(instrumentUid: string, interval: CandleInterval | null): string {
  return `${instrumentUid}:${interval}`
}

function sampleState(
  sample: LevelMonitorSample | undefined,
  now: number,
  staleAfter: number,
): LevelMonitorFeedState {
  if (!sample) return "missing"
  return now - sample.timestamp > staleAfter ? "stale" : "live"
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError"
}
