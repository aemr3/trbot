import { z } from "zod"
import { calendarKey, CalendarPeriodSchema, type CalendarPeriod } from "./calendar.ts"

export const CANDLE_RANGES = ["INTRADAY", "WEEK", "MONTH", "THREE_MONTH", "YEAR", "FIVE_YEAR", "ALL"] as const

export type CandleRange = (typeof CANDLE_RANGES)[number]

export const CANDLE_CHART_TARGETS = ["UNDERLYING", "INSTRUMENT", "BIST_100", "BIST_30"] as const
export type CandleChartTarget = (typeof CANDLE_CHART_TARGETS)[number]

export type CandleInstrumentTarget = Extract<CandleChartTarget, "UNDERLYING" | "INSTRUMENT">

/**
 * A VIOP contract resolved entirely inside the market-data feed.
 *
 * `candleSymbol` is the exact ticker the candle endpoint accepts. It differs
 * from `contractSymbol` when the requested chart is for the cash/spot
 * underlying.
 */
export interface ResolvedCandleInstrument {
  candleSymbol: string
  contractSymbol: string
  underlyingSymbol: string | null
  displayName: string
}

export interface CandleInstrumentResolver {
  resolveCandleInstrument(
    symbol: string,
    target: CandleInstrumentTarget,
    options?: { signal?: AbortSignal },
  ): Promise<ResolvedCandleInstrument>
}

export function isCandleChartTarget(value: string): value is CandleChartTarget {
  return CANDLE_CHART_TARGETS.some((target) => target === value)
}

export const CANDLE_RANGE_LABELS = {
  INTRADAY: "1D",
  WEEK: "1W",
  MONTH: "1M",
  THREE_MONTH: "3M",
  YEAR: "1Y",
  FIVE_YEAR: "5Y",
  ALL: "All",
} satisfies Record<CandleRange, string>

export const CANDLE_INTERVALS = [
  "MIN_1",
  "MIN_5",
  "MIN_15",
  "MIN_30",
  "HOUR_1",
  "HOUR_4",
  "DAY_1",
  "WEEK_1",
  "MONTH_1",
] as const

export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

export interface CandleIntervalsByRange extends Record<CandleRange, CandleInterval[]> {}

export const CANDLE_INTERVAL_LABELS = {
  MIN_1: "1m",
  MIN_5: "5m",
  MIN_15: "15m",
  MIN_30: "30m",
  HOUR_1: "1h",
  HOUR_4: "4h",
  DAY_1: "1D",
  WEEK_1: "1W",
  MONTH_1: "1M",
} satisfies Record<CandleInterval, string>

/** The grain a range opens at, when the trader has expressed no preference. */
export const DEFAULT_INTERVAL_BY_RANGE = {
  INTRADAY: "MIN_5",
  WEEK: "MIN_15",
  MONTH: "HOUR_1",
  THREE_MONTH: "HOUR_4",
  YEAR: "DAY_1",
  FIVE_YEAR: "WEEK_1",
  ALL: "MONTH_1",
} satisfies Record<CandleRange, CandleInterval>

/**
 * Range and timeframe are independent: every range can be read at every grain.
 *
 * The brokerage feed served one fixed grain per range, so a range used to pick
 * the timeframe and the two could not be chosen separately. The market data feed
 * has no such restriction. What varies now is how far back a grain reaches — one
 * minute bars run out after weeks while daily bars go back two decades — and a
 * range that outruns its grain simply shows the history that exists.
 */
export const DEFAULT_INTERVALS_BY_RANGE: CandleIntervalsByRange = {
  INTRADAY: [...CANDLE_INTERVALS],
  WEEK: [...CANDLE_INTERVALS],
  MONTH: [...CANDLE_INTERVALS],
  THREE_MONTH: [...CANDLE_INTERVALS],
  YEAR: [...CANDLE_INTERVALS],
  FIVE_YEAR: [...CANDLE_INTERVALS],
  ALL: [...CANDLE_INTERVALS],
}

/** The grains a rule or alert may watch a close on, finest first. */
export const RULE_INTERVALS: CandleInterval[] = [...CANDLE_INTERVALS]

/**
 * The grain a new rule or alert watches unless the trader picks another.
 *
 * Stated rather than taken from the head of the list: the finest grain now
 * available is one minute, and a stop that reacts to a one-minute close fires on
 * noise a trader did not intend to trade.
 */
export const DEFAULT_RULE_INTERVAL: CandleInterval = "MIN_5"

const RANGE_FOR_INTERVAL = new Map<CandleInterval, CandleRange>([
  ["MIN_1", "INTRADAY"],
  ["MIN_5", "INTRADAY"],
  ["MIN_15", "WEEK"],
  ["MIN_30", "WEEK"],
  ["HOUR_1", "MONTH"],
  ["HOUR_4", "THREE_MONTH"],
  ["DAY_1", "YEAR"],
  ["WEEK_1", "FIVE_YEAR"],
  ["MONTH_1", "ALL"],
])

/**
 * A range wide enough to read `interval` usefully.
 *
 * A range no longer selects the grain — the two are independent — but a read
 * still has to name one, and it has to be wide enough that an indicator window
 * is satisfied. Too narrow a range starves an ATR of bars and it silently
 * reports nothing.
 */
export function rangeForInterval(interval: CandleInterval): CandleRange {
  return RANGE_FOR_INTERVAL.get(interval) ?? "MONTH"
}

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export const CandleSchema: z.ZodType<Candle> = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nullable(),
})

export interface CandleSeries {
  instrumentUid: string
  range: CandleRange
  interval: CandleInterval
  candles: Candle[]
  availableIntervalsByRange: Record<CandleRange, CandleInterval[]>
  intervalMs: number | null
  currency: string | null
  /**
   * Set when the bars are cut on the exchange's calendar rather than by a fixed
   * span, which no weekly or monthly bar has. Whether such a bar has finished is
   * decided by the period it falls in, not by adding `intervalMs` to its stamp —
   * `intervalMs` remains the nominal width, for spacing a chart's axis.
   */
  calendarPeriod?: CalendarPeriod | null
}

export const CandleSeriesSchema: z.ZodType<CandleSeries> = z.object({
  instrumentUid: z.string(),
  range: z.enum(CANDLE_RANGES),
  interval: z.enum(CANDLE_INTERVALS),
  candles: z.array(CandleSchema),
  availableIntervalsByRange: z.record(z.enum(CANDLE_RANGES), z.array(z.enum(CANDLE_INTERVALS))),
  intervalMs: z.number().nullable(),
  currency: z.string().nullable(),
  calendarPeriod: CalendarPeriodSchema.nullish(),
})

export interface CandleSource {
  loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
    options?: { signal?: AbortSignal; target?: CandleChartTarget },
  ): Promise<CandleSeries>
}

export function isCandleRange(value: string): value is CandleRange {
  return CANDLE_RANGES.some((range) => range === value)
}

export function isCandleInterval(value: string): value is CandleInterval {
  return CANDLE_INTERVALS.some((interval) => interval === value)
}

/**
 * Candles that have finished, given when the series was read. A forming candle
 * keeps changing, so anything deciding on a close has to leave it out.
 */
export function closedCandles(series: CandleSeries, now: number): Candle[] {
  // A calendar bar is finished once the clock has left the period it belongs to.
  // Adding a nominal width to its stamp would close a 31-day month a day early
  // and hold a short one open a day late.
  const period = series.calendarPeriod
  if (period) {
    const current = calendarKey(now, period)
    return series.candles.filter((candle) => calendarKey(candle.timestamp, period) < current)
  }
  const intervalMs = series.intervalMs
  if (!intervalMs || intervalMs <= 0) return series.candles.slice(0, -1)
  return series.candles.filter((candle) => candle.timestamp + intervalMs <= now)
}

/**
 * Wilder's average true range over the last `period` candles: the average move
 * per candle, counting gaps from the previous close. Null when the series is
 * too short to smooth. Pass closed candles only — a forming one drags the
 * reading around as it prints.
 */
export function averageTrueRange(candles: Candle[], period = 14): number | null {
  return averageTrueRangeSeries(candles, period).at(-1) ?? null
}

/** Wilder ATR aligned to its source candles; the first `period` changes are warm-up. */
export function averageTrueRangeSeries(candles: Candle[], period = 14): (number | null)[] {
  const values: (number | null)[] = candles.map(() => null)
  if (!Number.isInteger(period) || period <= 0 || candles.length < period + 1) return values
  let average = 0
  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index]!
    const previousClose = candles[index - 1]!.close
    const range = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
    if (!Number.isFinite(range)) return candles.map(() => null)
    if (index <= period) {
      average += range
      if (index === period) {
        average /= period
        values[index] = average > 0 ? average : null
      }
      continue
    }
    average = (average * (period - 1) + range) / period
    values[index] = average > 0 ? average : null
  }
  return values
}

export function applyLivePrice(series: CandleSeries, price: number, timestamp: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return false
  const last = series.candles.at(-1)
  if (!last || timestamp < last.timestamp) return false
  const period = series.calendarPeriod

  // A tick in a later calendar period opens a bar rather than extending the last
  // one, stamped where the period's first print actually landed — which is how a
  // folded calendar bar is stamped too.
  if (period && calendarKey(timestamp, period) !== calendarKey(last.timestamp, period)) {
    series.candles.push({ timestamp, open: price, high: price, low: price, close: price, volume: null })
    return true
  }

  const intervalMs = period ? null : series.intervalMs

  if (intervalMs && intervalMs > 0 && timestamp >= last.timestamp + intervalMs) {
    const elapsedIntervals = Math.floor((timestamp - last.timestamp) / intervalMs)
    series.candles.push({
      timestamp: last.timestamp + elapsedIntervals * intervalMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: null,
    })
    return true
  }

  last.close = price
  last.high = Math.max(last.high, price)
  last.low = Math.min(last.low, price)
  return true
}
