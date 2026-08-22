import type { BrokerageDatePreset } from "@trbot/market/broker-calendar.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import { marketDate } from "./session-hours.ts"

/**
 * The trading days a broker reading can be taken over.
 *
 * The feed publishes no calendar of its own, so the days come from where the
 * exchange actually traded: the instrument's own daily bars. That is stricter
 * than a holiday list, and deliberately so — a stock halted for a week has no
 * bars over it and no broker figures either, so offering those days would only
 * produce empty readings.
 */

/**
 * How far back the range picker reaches.
 *
 * Both broker readings answer for years rather than months — the custody register
 * still returns rows for 2023 — so the picker offers five years of sessions and
 * the readings decide what they have. A year was the earlier cap and it was
 * shorter than either endpoint.
 */
const CALENDAR_RANGE = "FIVE_YEAR"

/** How long a symbol's day list is trusted before being re-read. */
const DEFAULT_TTL_MS = 30 * 60_000

/** The spans offered beside the current session, in trading days. */
const PRESET_SESSIONS = [5, 22, 66]

export interface FeedTradingDaysOptions {
  ttlMs?: number
  now?: () => number
}

export class FeedTradingDays {
  private readonly cache = new Map<string, { dates: string[]; readAt: number }>()
  private readonly loading = new Map<string, Promise<string[]>>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly candles: Pick<CandleSource, "loadCandles">,
    options: FeedTradingDaysOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** A symbol's trading days, newest first, as `YYYY-MM-DD` in exchange time. */
  async list(symbol: string, signal?: AbortSignal): Promise<string[]> {
    const cached = this.cache.get(symbol)
    if (cached && this.now() - cached.readAt < this.ttlMs) return cached.dates

    const pending = this.loading.get(symbol)
    if (pending) return pending

    const read = this.candles
      .loadCandles(symbol, CALENDAR_RANGE, "DAY_1", { signal })
      .then((series) => {
        const dates = [...new Set(series.candles.map((candle) => marketDate(candle.timestamp)))]
          .sort()
          .reverse()
        this.cache.set(symbol, { dates, readAt: this.now() })
        return dates
      })
      .finally(() => {
        this.loading.delete(symbol)
      })
    this.loading.set(symbol, read)
    return read
  }
}

/**
 * The named spans the range picker offers.
 *
 * The current session keeps a null range: the feeds answer it without a date, so
 * leaving it null means the reading follows the session over a rollover instead
 * of pinning itself to the day the picker was opened.
 */
export function tradingDayPresets(dates: string[]): BrokerageDatePreset[] {
  const presets: BrokerageDatePreset[] = [{ range: { start: null, end: null }, isDefault: true }]
  const end = dates[0]
  if (!end) return presets
  for (const sessions of PRESET_SESSIONS) {
    const start = dates[sessions - 1]
    if (!start) continue
    presets.push({ range: { start, end }, isDefault: false })
  }
  return presets
}
