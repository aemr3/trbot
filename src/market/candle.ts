export const CANDLE_RANGES = ["INTRADAY", "WEEK", "MONTH", "THREE_MONTH", "YEAR", "FIVE_YEAR"] as const

export type CandleRange = (typeof CANDLE_RANGES)[number]

export const CANDLE_CHART_TARGETS = ["UNDERLYING", "INSTRUMENT"] as const
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
