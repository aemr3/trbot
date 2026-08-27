import { closedCandles, type Candle, type CandleSeries } from "./candle.ts"
import { marketDayKey } from "./calendar.ts"

const MINUTE_MS = 60_000
const RELATIVE_VOLUME_BASELINE_SESSIONS = 20

export interface SessionOhlcv {
  date: string
  firstCandleTimestamp: number
  lastCandleTimestamp: number
  candleCount: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface OpeningRangeContext {
  minutes: number
  endsAt: number | null
  status: "CONFIRMED" | "FORMING" | "UNAVAILABLE"
  confirmed: SessionOhlcv | null
  provisional: SessionOhlcv | null
}

export interface RelativeVolumeReading {
  ratio: number | null
  currentVolume: number | null
  averageComparableVolume: number | null
  comparisonBars: number
  baselineSessions: number
}

export interface IntradayCandleContext {
  asOf: number
  interval: CandleSeries["interval"]
  intervalMs: number | null
  lastCompletedTimestamp: number | null
  formingTimestamp: number | null
  previousSession: SessionOhlcv | null
  currentSession: {
    date: string | null
    confirmed: SessionOhlcv | null
    provisional: SessionOhlcv | null
  }
  openingRanges: {
    minutes15: OpeningRangeContext
    minutes30: OpeningRangeContext
  }
  relativeVolume: {
    confirmed: RelativeVolumeReading | null
    provisional: RelativeVolumeReading | null
  }
}

export interface SessionRelativeStrength {
  date: string
  throughTimestamp: number
  targetReturnPercent: number
  benchmarkReturnPercent: number
  excessReturnPercentagePoints: number
}

/**
 * Builds session levels and time-matched volume without looking beyond `asOf`.
 * Confirmed fields use closed candles only; provisional fields include the one
 * currently forming candle when the source exposes it.
 */
export function intradayCandleContext(series: CandleSeries, asOf: number): IntradayCandleContext {
  const ordered = [...series.candles].sort((left, right) => left.timestamp - right.timestamp)
  const pointInTimeSeries = { ...series, candles: ordered }
  const visible = ordered.filter((candle) => candle.timestamp <= asOf)
  const completed = closedCandles(pointInTimeSeries, asOf)
    .filter((candle) => candle.timestamp <= asOf)
  const sessions = groupBySession(visible)
  const currentDate = sessions.at(-1)?.date ?? null
  const currentVisible = currentDate === null
    ? []
    : visible.filter((candle) => marketDayKey(candle.timestamp) === currentDate)
  const currentCompleted = currentDate === null
    ? []
    : completed.filter((candle) => marketDayKey(candle.timestamp) === currentDate)
  const hasFormingCandle = currentVisible.length > currentCompleted.length
  const priorSessions = sessions.slice(0, -1)
  const previous = priorSessions.at(-1) ?? null

  return {
    asOf,
    interval: series.interval,
    intervalMs: series.intervalMs,
    lastCompletedTimestamp: completed.at(-1)?.timestamp ?? null,
    formingTimestamp: hasFormingCandle ? currentVisible.at(-1)?.timestamp ?? null : null,
    previousSession: previous === null ? null : summarizeSession(previous.date, previous.candles),
    currentSession: {
      date: currentDate,
      confirmed: summarizeSession(currentDate, currentCompleted),
      provisional: hasFormingCandle ? summarizeSession(currentDate, currentVisible) : null,
    },
    openingRanges: {
      minutes15: openingRange(currentDate, currentVisible, currentCompleted, 15, series.intervalMs, asOf),
      minutes30: openingRange(currentDate, currentVisible, currentCompleted, 30, series.intervalMs, asOf),
    },
    relativeVolume: {
      confirmed: relativeVolume(currentCompleted, priorSessions),
      provisional: hasFormingCandle ? relativeVolume(currentVisible, priorSessions) : null,
    },
  }
}

/** Session return spread at the newest timestamp closed in both series. */
export function sessionRelativeStrength(
  target: CandleSeries,
  benchmark: CandleSeries,
  asOf: number,
): SessionRelativeStrength | null {
  const targetCompleted = closedCandles(target, asOf)
    .filter((candle) => candle.timestamp <= asOf)
    .sort((left, right) => left.timestamp - right.timestamp)
  const latestTarget = targetCompleted.at(-1)
  if (!latestTarget) return null

  const date = marketDayKey(latestTarget.timestamp)
  const targetSession = targetCompleted.filter((candle) => marketDayKey(candle.timestamp) === date)
  const benchmarkSession = closedCandles(benchmark, asOf)
    .filter((candle) => candle.timestamp <= asOf && marketDayKey(candle.timestamp) === date)
    .sort((left, right) => left.timestamp - right.timestamp)
  const targetOpen = targetSession[0]?.open
  const benchmarkOpen = benchmarkSession[0]?.open
  if (targetOpen === undefined || targetOpen === 0 || benchmarkOpen === undefined || benchmarkOpen === 0) return null

  const benchmarkByTimestamp = new Map(benchmarkSession.map((candle) => [candle.timestamp, candle]))
  const commonTarget = targetSession.findLast((candle) => benchmarkByTimestamp.has(candle.timestamp))
  if (!commonTarget) return null
  const commonBenchmark = benchmarkByTimestamp.get(commonTarget.timestamp)
  if (!commonBenchmark) return null

  const targetReturnPercent = percentageChange(commonTarget.close, targetOpen)
  const benchmarkReturnPercent = percentageChange(commonBenchmark.close, benchmarkOpen)
  return {
    date,
    throughTimestamp: commonTarget.timestamp,
    targetReturnPercent,
    benchmarkReturnPercent,
    excessReturnPercentagePoints: targetReturnPercent - benchmarkReturnPercent,
  }
}

interface SessionCandles {
  date: string
  candles: Candle[]
}

function groupBySession(candles: Candle[]): SessionCandles[] {
  const sessions = new Map<string, Candle[]>()
  for (const candle of candles) {
    const date = marketDayKey(candle.timestamp)
    const session = sessions.get(date)
    if (session) session.push(candle)
    else sessions.set(date, [candle])
  }
  return [...sessions].map(([date, sessionCandles]) => ({ date, candles: sessionCandles }))
}

function summarizeSession(date: string | null, candles: Candle[]): SessionOhlcv | null {
  const first = candles[0]
  const last = candles.at(-1)
  if (date === null || !first || !last) return null
  let high = first.high
  let low = first.low
  let volume: number | null = 0
  for (const candle of candles) {
    high = Math.max(high, candle.high)
    low = Math.min(low, candle.low)
    volume = volume === null || candle.volume === null ? null : volume + candle.volume
  }
  return {
    date,
    firstCandleTimestamp: first.timestamp,
    lastCandleTimestamp: last.timestamp,
    candleCount: candles.length,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  }
}

function openingRange(
  date: string | null,
  visible: Candle[],
  completed: Candle[],
  minutes: number,
  intervalMs: number | null,
  asOf: number,
): OpeningRangeContext {
  const first = visible[0]
  const durationMs = minutes * MINUTE_MS
  if (!first || !intervalMs || intervalMs <= 0 || intervalMs > durationMs) {
    return { minutes, endsAt: null, status: "UNAVAILABLE", confirmed: null, provisional: null }
  }
  const endsAt = first.timestamp + durationMs
  const visibleRange = visible.filter((candle) => candle.timestamp < endsAt)
  const completedRange = completed.filter((candle) => candle.timestamp < endsAt)
  const lastCompleted = completedRange.at(-1)
  const confirmed = asOf >= endsAt
    && visibleRange.length === completedRange.length
    && lastCompleted !== undefined
    && lastCompleted.timestamp + intervalMs >= endsAt
  return {
    minutes,
    endsAt,
    status: confirmed ? "CONFIRMED" : "FORMING",
    confirmed: confirmed ? summarizeSession(date, completedRange) : null,
    provisional: confirmed ? null : summarizeSession(date, visibleRange),
  }
}

function relativeVolume(
  current: Candle[],
  priorSessions: SessionCandles[],
): RelativeVolumeReading | null {
  const comparisonBars = current.length
  if (comparisonBars === 0) return null
  const currentVolume = reportedVolume(current)
  const comparableVolumes = priorSessions
    .slice(-RELATIVE_VOLUME_BASELINE_SESSIONS)
    .flatMap(({ candles }) => {
      if (candles.length < comparisonBars) return []
      const volume = reportedVolume(candles.slice(0, comparisonBars))
      return volume === null ? [] : [volume]
    })
  const averageComparableVolume = comparableVolumes.length === 0
    ? null
    : comparableVolumes.reduce((sum, volume) => sum + volume, 0) / comparableVolumes.length
  return {
    ratio: currentVolume !== null && averageComparableVolume !== null && averageComparableVolume > 0
      ? currentVolume / averageComparableVolume
      : null,
    currentVolume,
    averageComparableVolume,
    comparisonBars,
    baselineSessions: comparableVolumes.length,
  }
}

function reportedVolume(candles: Candle[]): number | null {
  let total = 0
  for (const candle of candles) {
    if (candle.volume === null) return null
    total += candle.volume
  }
  return total
}

function percentageChange(value: number, start: number): number {
  return (value / start - 1) * 100
}
