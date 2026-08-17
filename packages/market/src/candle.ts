export const CANDLE_RANGES = ["INTRADAY", "WEEK", "MONTH", "THREE_MONTH", "YEAR", "FIVE_YEAR"] as const

export type CandleRange = (typeof CANDLE_RANGES)[number]

export const CANDLE_CHART_TARGETS = ["UNDERLYING", "INSTRUMENT", "BIST_100", "BIST_30"] as const
export type CandleChartTarget = (typeof CANDLE_CHART_TARGETS)[number]

export function isCandleChartTarget(value: string): value is CandleChartTarget {
  return CANDLE_CHART_TARGETS.some((target) => target === value)
}

export const CANDLE_RANGE_LABELS: Record<CandleRange, string> = {
  INTRADAY: "1D",
  WEEK: "1W",
  MONTH: "1M",
  THREE_MONTH: "3M",
  YEAR: "1Y",
  FIVE_YEAR: "5Y",
}

export const CANDLE_INTERVALS = [
  "MIN_5",
  "MIN_10",
  "MIN_15",
  "MIN_30",
  "HOUR_1",
  "HOUR_4",
  "DAY_1",
  "WEEK_1",
  "MONTH_1",
] as const

export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

export const CANDLE_INTERVAL_LABELS: Record<CandleInterval, string> = {
  MIN_5: "5m",
  MIN_10: "10m",
  MIN_15: "15m",
  MIN_30: "30m",
  HOUR_1: "1h",
  HOUR_4: "4h",
  DAY_1: "1D",
  WEEK_1: "1W",
  MONTH_1: "1M",
}

export const DEFAULT_INTERVAL_BY_RANGE: Record<CandleRange, CandleInterval> = {
  INTRADAY: "MIN_5",
  WEEK: "HOUR_1",
  MONTH: "HOUR_1",
  THREE_MONTH: "HOUR_4",
  YEAR: "DAY_1",
  FIVE_YEAR: "WEEK_1",
}

export const DEFAULT_INTERVALS_BY_RANGE: Record<CandleRange, CandleInterval[]> = {
  INTRADAY: ["MIN_5", "MIN_10", "MIN_15", "MIN_30", "HOUR_1"],
  WEEK: ["MIN_10", "MIN_15", "MIN_30", "HOUR_1"],
  MONTH: ["HOUR_1", "HOUR_4", "DAY_1"],
  THREE_MONTH: ["HOUR_4", "DAY_1", "WEEK_1"],
  YEAR: ["DAY_1", "WEEK_1"],
  FIVE_YEAR: ["WEEK_1", "MONTH_1"],
}

// Futures candles are served one grain per range: the provider infers the
// interval from the range instead of taking a requested one, so these are the
// only grains a contract can actually be watched at.
export const FUTURES_INTERVALS_BY_RANGE: Record<CandleRange, CandleInterval[]> = {
  INTRADAY: ["MIN_10"],
  WEEK: ["HOUR_1"],
  MONTH: ["HOUR_4"],
  THREE_MONTH: ["DAY_1"],
  YEAR: ["DAY_1"],
  FIVE_YEAR: ["DAY_1"],
}

/** The grains a futures contract can be read at, finest first. */
export const FUTURES_INTERVALS: CandleInterval[] = ["MIN_10", "HOUR_1", "HOUR_4", "DAY_1"]

/** The range that yields `interval` for a futures contract, or null for none. */
export function futuresRangeForInterval(interval: CandleInterval): CandleRange | null {
  return CANDLE_RANGES.find((range) => FUTURES_INTERVALS_BY_RANGE[range][0] === interval) ?? null
}

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface CandleSeries {
  instrumentUid: string
  range: CandleRange
  interval: CandleInterval
  candles: Candle[]
  availableIntervalsByRange: Record<CandleRange, CandleInterval[]>
  intervalMs: number | null
  currency: string | null
}

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
  if (!Number.isInteger(period) || period <= 0 || candles.length < period + 1) return null
  const ranges: number[] = []
  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index]!
    const previousClose = candles[index - 1]!.close
    const range = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
    if (!Number.isFinite(range)) return null
    ranges.push(range)
  }
  if (ranges.length < period) return null

  // Seed with the first `period` ranges, then smooth the rest into it.
  let average = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period
  for (let index = period; index < ranges.length; index++) {
    average = (average * (period - 1) + ranges[index]!) / period
  }
  return average > 0 ? average : null
}

export function applyLivePrice(series: CandleSeries, price: number, timestamp: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return false
  const last = series.candles.at(-1)
  if (!last || timestamp < last.timestamp) return false
  const intervalMs = series.intervalMs

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
