// Overlays drawn on the price pane of the candle chart. Every indicator is a
// pure function from candles to one value per candle, aligned to the series so
// a chart can slice it the same way it slices the candles; a value is null
// wherever the indicator has nothing to say yet.
import type { Candle } from "./candle.ts"

export const CHART_INDICATORS = ["EMA_20", "EMA_50", "EMA_100", "VWAP", "BOLLINGER"] as const
export type ChartIndicator = (typeof CHART_INDICATORS)[number]

export const CHART_INDICATOR_LABELS: Record<ChartIndicator, string> = {
  EMA_20: "EMA20",
  EMA_50: "EMA50",
  EMA_100: "EMA100",
  VWAP: "VWAP",
  BOLLINGER: "BB",
}

// Distinct from the up/down colors, so an overlay is never read as a candle.
export const CHART_INDICATOR_COLORS: Record<ChartIndicator, string> = {
  EMA_20: "#e5c07b",
  EMA_50: "#61afef",
  EMA_100: "#c678dd",
  VWAP: "#56b6c2",
  BOLLINGER: "#7a8699",
}

const EMA_PERIODS: Record<"EMA_20" | "EMA_50" | "EMA_100", number> = {
  EMA_20: 20,
  EMA_50: 50,
  EMA_100: 100,
}

const BOLLINGER_PERIOD = 20
const BOLLINGER_DEVIATIONS = 2

const DAY_MS = 86_400_000

export function isChartIndicator(value: string): value is ChartIndicator {
  return CHART_INDICATORS.some((indicator) => indicator === value)
}

/** One drawable line: a color and one value per candle of the source series. */
export interface IndicatorLine {
  indicator: ChartIndicator
  color: string
  values: (number | null)[]
}

/**
 * Exponential moving average of the closes, seeded with the simple average of
 * the first `period` candles. Values before that are null rather than a
 * half-warmed average that would draw a line the market never traded at.
 */
export function exponentialMovingAverage(candles: Candle[], period: number): (number | null)[] {
  const values: (number | null)[] = candles.map(() => null)
  if (period <= 0 || candles.length < period) return values
  const weight = 2 / (period + 1)
  let sum = 0
  for (let index = 0; index < period; index++) sum += candles[index]!.close
  let average = sum / period
  values[period - 1] = average
  for (let index = period; index < candles.length; index++) {
    average = candles[index]!.close * weight + average * (1 - weight)
    values[index] = average
  }
  return values
}

/**
 * Volume-weighted average price, restarted each session: VWAP measures where
 * the day's volume actually traded, so carrying it across days would average
 * away the very thing it is read for. Null while a session has no volume.
 */
export function volumeWeightedAveragePrice(candles: Candle[]): (number | null)[] {
  const values: (number | null)[] = []
  let session: string | null = null
  let priceVolume = 0
  let volume = 0
  for (const candle of candles) {
    const day = sessionDay(candle.timestamp)
    if (day !== session) {
      session = day
      priceVolume = 0
      volume = 0
    }
    const size = candle.volume ?? 0
    priceVolume += ((candle.high + candle.low + candle.close) / 3) * size
    volume += size
    values.push(volume > 0 ? priceVolume / volume : null)
  }
  return values
}

/**
 * Bollinger bands: a simple moving average of the closes with a band at
 * `deviations` standard deviations either side, returned as three lines in
 * drawing order.
 */
export function bollingerBands(
  candles: Candle[],
  period = BOLLINGER_PERIOD,
  deviations = BOLLINGER_DEVIATIONS,
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = candles.map(() => null)
  const middle: (number | null)[] = candles.map(() => null)
  const lower: (number | null)[] = candles.map(() => null)
  if (period <= 0) return { upper, middle, lower }
  for (let index = period - 1; index < candles.length; index++) {
    let sum = 0
    for (let back = 0; back < period; back++) sum += candles[index - back]!.close
    const average = sum / period
    let variance = 0
    for (let back = 0; back < period; back++) {
      const difference = candles[index - back]!.close - average
      variance += difference * difference
    }
    const spread = Math.sqrt(variance / period) * deviations
    middle[index] = average
    upper[index] = average + spread
    lower[index] = average - spread
  }
  return { upper, middle, lower }
}

/**
 * The lines the chart should draw for the active indicators, in the order they
 * are listed. VWAP is dropped on daily candles and coarser: one candle per
 * session makes it a restatement of that candle rather than an average.
 */
export function indicatorLines(
  candles: Candle[],
  active: readonly ChartIndicator[],
  grainMs: number | null,
): IndicatorLine[] {
  if (candles.length === 0) return []
  const lines: IndicatorLine[] = []
  for (const indicator of CHART_INDICATORS) {
    if (!active.includes(indicator)) continue
    const color = CHART_INDICATOR_COLORS[indicator]
    if (indicator === "BOLLINGER") {
      const bands = bollingerBands(candles)
      lines.push(
        { indicator, color, values: bands.upper },
        { indicator, color, values: bands.lower },
        { indicator, color, values: bands.middle },
      )
      continue
    }
    if (indicator === "VWAP") {
      if (grainMs !== null && grainMs >= DAY_MS) continue
      lines.push({ indicator, color, values: volumeWeightedAveragePrice(candles) })
      continue
    }
    lines.push({ indicator, color, values: exponentialMovingAverage(candles, EMA_PERIODS[indicator]) })
  }
  return lines
}

function sessionDay(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "short", timeZone: "Europe/Istanbul" })
    .format(new Date(timestamp))
}
