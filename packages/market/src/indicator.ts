// Overlays drawn on the price pane of the candle chart. Every indicator is a
// pure function from candles to one value per candle, aligned to the series so
// a chart can slice it the same way it slices the candles; a value is null
// wherever the indicator has nothing to say yet.
import { averageTrueRangeSeries, type Candle } from "./candle.ts"
import { MARKET_TIME_ZONE, marketDayKey } from "./calendar.ts"

export const CANDLE_INDICATORS = [
  "EMA_20",
  "EMA_50",
  "EMA_100",
  "VWAP",
  "BOLLINGER",
  "ATR_14",
  "RSI_14",
  "MACD",
  "PIVOT_DAILY_CLASSIC",
  "RELATIVE_VOLUME",
] as const
export type CandleIndicator = (typeof CANDLE_INDICATORS)[number]

export const CANDLE_INDICATOR_DESCRIPTIONS = {
  EMA_20: "20-bar exponential moving average of closes",
  EMA_50: "50-bar exponential moving average of closes",
  EMA_100: "100-bar exponential moving average of closes; prefer it for higher-timeframe context",
  VWAP: `Intraday-only bar-estimated HLC3 VWAP weighted by candle volume and reset each ${MARKET_TIME_ZONE} calendar date`,
  BOLLINGER: "20-bar close SMA with upper and lower bands at two population standard deviations",
  ATR_14: "14-change Wilder average true range; use completed bars for risk decisions",
  RSI_14: "14-change Wilder relative strength index of closes",
  MACD: "12/26-bar EMA difference with a 9-bar EMA signal and histogram",
  PIVOT_DAILY_CLASSIC: `Classic floor pivots from the previous observed ${MARKET_TIME_ZONE} trading date, projected across the current date; requires a range containing at least two dates`,
  RELATIVE_VOLUME: `Cumulative ${MARKET_TIME_ZONE} session volume divided by the average cumulative volume through the same bar count over up to the prior 20 sessions in range; 1 is the typical pace and null until a prior comparable session exists`,
} as const satisfies Record<CandleIndicator, string>

// Keep the terminal chart's compact overlay controls separate from the larger
// indicator set available to agents.
export const CHART_INDICATORS = ["EMA_20", "EMA_50", "EMA_100", "VWAP", "BOLLINGER"] as const satisfies readonly CandleIndicator[]
export type ChartIndicator = (typeof CHART_INDICATORS)[number]

export const CHART_INDICATOR_LABELS = {
  EMA_20: "EMA20",
  EMA_50: "EMA50",
  EMA_100: "EMA100",
  VWAP: "VWAP",
  BOLLINGER: "BB",
} satisfies Record<ChartIndicator, string>

// Distinct from the up/down colors, so an overlay is never read as a candle.
export const CHART_INDICATOR_COLORS = {
  EMA_20: "#e5c07b",
  EMA_50: "#61afef",
  EMA_100: "#c678dd",
  VWAP: "#56b6c2",
  BOLLINGER: "#7a8699",
} satisfies Record<ChartIndicator, string>

const EMA_PERIODS = {
  EMA_20: 20,
  EMA_50: 50,
  EMA_100: 100,
} satisfies Record<"EMA_20" | "EMA_50" | "EMA_100", number>

const BOLLINGER_PERIOD = 20
const BOLLINGER_DEVIATIONS = 2
const RELATIVE_VOLUME_BASELINE_SESSIONS = 20

export interface BollingerBands {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
}

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

/** Named, index-aligned lines returned for one requested candle indicator. */
export interface CandleIndicatorSeries {
  indicator: CandleIndicator
  semantics: string
  lines: Record<string, (number | null)[]>
  /** Full-series indexes where every line for this indicator has a value. */
  availability: {
    firstAvailableIndex: number | null
    latestAvailableIndex: number | null
  }
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
 * Bar-estimated volume-weighted average price, restarted each exchange-local
 * calendar date. All sessions on that date share the same VWAP; null while the
 * date has no reported volume.
 */
export function volumeWeightedAveragePrice(candles: Candle[]): (number | null)[] {
  const values: (number | null)[] = []
  let currentDay: string | null = null
  let priceVolume = 0
  let volume = 0
  for (const candle of candles) {
    const day = marketDayKey(candle.timestamp)
    if (day !== currentDay) {
      currentDay = day
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
): BollingerBands {
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

/** Wilder RSI of candle closes, neutral when a full window has no movement. */
export function relativeStrengthIndex(candles: Candle[], period = 14): (number | null)[] {
  const values: (number | null)[] = candles.map(() => null)
  if (!Number.isInteger(period) || period <= 0 || candles.length < period + 1) return values
  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index < candles.length; index++) {
    const change = candles[index]!.close - candles[index - 1]!.close
    if (!Number.isFinite(change)) return candles.map(() => null)
    const gain = Math.max(0, change)
    const loss = Math.max(0, -change)
    if (index <= period) {
      averageGain += gain
      averageLoss += loss
      if (index === period) {
        averageGain /= period
        averageLoss /= period
        values[index] = relativeStrength(averageGain, averageLoss)
      }
      continue
    }
    averageGain = (averageGain * (period - 1) + gain) / period
    averageLoss = (averageLoss * (period - 1) + loss) / period
    values[index] = relativeStrength(averageGain, averageLoss)
  }
  return values
}

export interface MacdSeries {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
}

/** Standard 12/26 EMA MACD with a 9-period EMA signal line. */
export function movingAverageConvergenceDivergence(
  candles: Candle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  const macd: (number | null)[] = candles.map(() => null)
  const signal: (number | null)[] = candles.map(() => null)
  const histogram: (number | null)[] = candles.map(() => null)
  if (
    !Number.isInteger(fastPeriod)
    || !Number.isInteger(slowPeriod)
    || !Number.isInteger(signalPeriod)
    || fastPeriod <= 0
    || slowPeriod <= fastPeriod
    || signalPeriod <= 0
  ) return { macd, signal, histogram }

  const fast = exponentialMovingAverage(candles, fastPeriod)
  const slow = exponentialMovingAverage(candles, slowPeriod)
  const start = slow.findIndex((value) => value !== null)
  if (start < 0) return { macd, signal, histogram }
  const macdValues: number[] = []
  for (let index = start; index < candles.length; index++) {
    const fastValue = fast[index]
    const slowValue = slow[index]
    if (fastValue === null || slowValue === null) continue
    const value = fastValue - slowValue
    macd[index] = value
    macdValues.push(value)
  }
  const signalValues = exponentialMovingAverageValues(macdValues, signalPeriod)
  for (let index = 0; index < signalValues.length; index++) {
    const signalValue = signalValues[index]
    const sourceIndex = start + index
    signal[sourceIndex] = signalValue
    const macdValue = macd[sourceIndex]
    if (signalValue !== null && macdValue !== null) histogram[sourceIndex] = macdValue - signalValue
  }
  return { macd, signal, histogram }
}

/**
 * Cumulative session volume relative to the average cumulative volume through
 * the same bar count over the prior sessions, so 09:35 is compared with 09:35.
 * Only prior sessions that reached the same bar count with reported volume
 * enter the baseline; the value is null while none has.
 */
export function relativeVolumeSeries(
  candles: Candle[],
  baselineSessions = RELATIVE_VOLUME_BASELINE_SESSIONS,
): (number | null)[] {
  const values: (number | null)[] = candles.map(() => null)
  const sessions: { day: string; cumulative: (number | null)[] }[] = []
  let current: { day: string; cumulative: (number | null)[] } | null = null
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const day = marketDayKey(candle.timestamp)
    if (current === null || current.day !== day) {
      current = { day, cumulative: [] }
      sessions.push(current)
    }
    const barIndex = current.cumulative.length
    const previous = barIndex === 0 ? 0 : current.cumulative[barIndex - 1] ?? null
    const cumulative = previous === null || candle.volume === null ? null : previous + candle.volume
    current.cumulative.push(cumulative)
    if (cumulative === null) continue
    const priorStart = Math.max(0, sessions.length - 1 - baselineSessions)
    let sum = 0
    let count = 0
    for (let session = priorStart; session < sessions.length - 1; session++) {
      const comparable = sessions[session]!.cumulative[barIndex]
      if (comparable === undefined || comparable === null) continue
      sum += comparable
      count++
    }
    if (count === 0 || sum <= 0) continue
    values[index] = cumulative / (sum / count)
  }
  return values
}

export interface DailyClassicPivotSeries {
  pivot: (number | null)[]
  r1: (number | null)[]
  r2: (number | null)[]
  r3: (number | null)[]
  s1: (number | null)[]
  s2: (number | null)[]
  s3: (number | null)[]
}

/** Classic floor pivots from the previous observed exchange-local trading date. */
export function dailyClassicPivotLevels(candles: Candle[]): DailyClassicPivotSeries {
  const series: DailyClassicPivotSeries = {
    pivot: candles.map(() => null),
    r1: candles.map(() => null),
    r2: candles.map(() => null),
    r3: candles.map(() => null),
    s1: candles.map(() => null),
    s2: candles.map(() => null),
    s3: candles.map(() => null),
  }
  let currentDay: string | null = null
  let currentSession: Candle | null = null
  let active: Record<keyof DailyClassicPivotSeries, number> | null = null

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const day = marketDayKey(candle.timestamp)
    if (day !== currentDay) {
      active = currentSession === null ? null : classicPivotSnapshot(currentSession)
      currentDay = day
      currentSession = { ...candle }
    } else if (currentSession !== null) {
      currentSession.high = Math.max(currentSession.high, candle.high)
      currentSession.low = Math.min(currentSession.low, candle.low)
      currentSession.close = candle.close
      currentSession.volume = currentSession.volume === null || candle.volume === null
        ? null
        : currentSession.volume + candle.volume
    }
    if (!active) continue
    series.pivot[index] = active.pivot
    series.r1[index] = active.r1
    series.r2[index] = active.r2
    series.r3[index] = active.r3
    series.s1[index] = active.s1
    series.s2[index] = active.s2
    series.s3[index] = active.s3
  }
  return series
}

/** Computes only requested indicators, all aligned to the original candle indexes. */
export function candleIndicatorSeries(
  candles: Candle[],
  active: readonly CandleIndicator[],
  grainMs: number | null,
): CandleIndicatorSeries[] {
  const result: CandleIndicatorSeries[] = []
  for (const indicator of CANDLE_INDICATORS) {
    if (!active.includes(indicator)) continue
    if (indicator === "BOLLINGER") {
      result.push(buildIndicatorSeries(indicator, { ...bollingerBands(candles) }))
    } else if (indicator === "VWAP") {
      result.push(buildIndicatorSeries(indicator, {
        vwap: grainMs !== null && grainMs >= DAY_MS
          ? candles.map(() => null)
          : volumeWeightedAveragePrice(candles),
      }))
    } else if (indicator === "ATR_14") {
      result.push(buildIndicatorSeries(indicator, { atr: averageTrueRangeSeries(candles, 14) }))
    } else if (indicator === "RSI_14") {
      result.push(buildIndicatorSeries(indicator, { rsi: relativeStrengthIndex(candles, 14) }))
    } else if (indicator === "MACD") {
      result.push(buildIndicatorSeries(indicator, { ...movingAverageConvergenceDivergence(candles) }))
    } else if (indicator === "PIVOT_DAILY_CLASSIC") {
      result.push(buildIndicatorSeries(indicator, { ...dailyClassicPivotLevels(candles) }))
    } else if (indicator === "RELATIVE_VOLUME") {
      result.push(buildIndicatorSeries(indicator, { ratio: relativeVolumeSeries(candles) }))
    } else {
      result.push(buildIndicatorSeries(indicator, {
        ema: exponentialMovingAverage(candles, EMA_PERIODS[indicator]),
      }))
    }
  }
  return result
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

/**
 * Reuses each chart overlay until its candle series changes. Live candles mutate
 * their array in place, so their owner must call `invalidate` after applying a
 * tick; replacing the array is detected automatically.
 */
export class ChartIndicatorCache {
  private candles: Candle[] | null = null
  private grainMs: number | null = null
  private readonly cached = new Map<ChartIndicator, IndicatorLine[]>()

  lines(candles: Candle[], active: readonly ChartIndicator[], grainMs: number | null): IndicatorLine[] {
    if (this.candles !== candles || this.grainMs !== grainMs) {
      this.candles = candles
      this.grainMs = grainMs
      this.cached.clear()
    }

    const lines: IndicatorLine[] = []
    for (const indicator of CHART_INDICATORS) {
      if (!active.includes(indicator)) continue
      let indicatorResult = this.cached.get(indicator)
      if (!indicatorResult) {
        indicatorResult = indicatorLines(candles, [indicator], grainMs)
        this.cached.set(indicator, indicatorResult)
      }
      lines.push(...indicatorResult)
    }
    return lines
  }

  invalidate(): void {
    this.candles = null
    this.cached.clear()
  }
}

function classicPivotSnapshot(previous: Candle): Record<keyof DailyClassicPivotSeries, number> | null {
  const pivot = (previous.high + previous.low + previous.close) / 3
  const width = previous.high - previous.low
  if (!Number.isFinite(pivot) || !Number.isFinite(width)) return null
  return {
    pivot,
    r1: 2 * pivot - previous.low,
    s1: 2 * pivot - previous.high,
    r2: pivot + width,
    s2: pivot - width,
    r3: previous.high + 2 * (pivot - previous.low),
    s3: previous.low - 2 * (previous.high - pivot),
  }
}

function buildIndicatorSeries(
  indicator: CandleIndicator,
  lines: CandleIndicatorSeries["lines"],
): CandleIndicatorSeries {
  return {
    indicator,
    semantics: CANDLE_INDICATOR_DESCRIPTIONS[indicator],
    lines,
    availability: lineAvailability(lines),
  }
}

function lineAvailability(lines: Record<string, (number | null)[]>): CandleIndicatorSeries["availability"] {
  const values = Object.values(lines)
  const length = values[0]?.length ?? 0
  let firstAvailableIndex: number | null = null
  let latestAvailableIndex: number | null = null
  for (let index = 0; index < length; index++) {
    if (!values.every((line) => line[index] !== null)) continue
    firstAvailableIndex ??= index
    latestAvailableIndex = index
  }
  return { firstAvailableIndex, latestAvailableIndex }
}

function exponentialMovingAverageValues(source: number[], period: number): (number | null)[] {
  const values: (number | null)[] = source.map(() => null)
  if (period <= 0 || source.length < period) return values
  let sum = 0
  for (let index = 0; index < period; index++) sum += source[index]!
  let average = sum / period
  values[period - 1] = average
  const weight = 2 / (period + 1)
  for (let index = period; index < source.length; index++) {
    average = source[index]! * weight + average * (1 - weight)
    values[index] = average
  }
  return values
}

function relativeStrength(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100
  if (averageGain === 0) return 0
  return 100 - 100 / (1 + averageGain / averageLoss)
}
