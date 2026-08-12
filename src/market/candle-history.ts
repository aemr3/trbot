import type { HistoricalBar, HistoricalBarSource } from "../api/historical-bars.ts"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleInterval, type CandleSeries } from "./candle.ts"
import type { ViopInstrument } from "./instrument.ts"

const FIVE_MINUTES_MS = 5 * 60_000
const TEN_MINUTES_MS = 10 * 60_000
const WARMUP_LOOKBACK_MS = 21 * 24 * 60 * 60_000

export interface CandleHistoryStore {
  put(instrumentUid: string, interval: CandleInterval, candles: Candle[]): Promise<void>
  list(instrumentUid: string, interval: CandleInterval): Promise<Candle[]>
}

export interface BacktestCandleSource {
  loadCandles(
    instrument: ViopInstrument,
    options: { sessionDate?: string; now: number; signal?: AbortSignal },
  ): Promise<CandleSeries>
  loadRange?(
    instrument: ViopInstrument,
    options: { startDate: string; endDate: string; now: number; signal?: AbortSignal },
  ): Promise<CandleSeries>
}

export class HistoricalBacktestCandleSource implements BacktestCandleSource {
  constructor(
    private readonly remote: HistoricalBarSource,
    private readonly history: CandleHistoryStore,
  ) {}

  async loadCandles(
    instrument: ViopInstrument,
    options: { sessionDate?: string; now: number; signal?: AbortSignal },
  ): Promise<CandleSeries> {
    const endDate = options.sessionDate ?? istanbulDate(options.now)
    return this.loadRange(instrument, { startDate: endDate, endDate, now: options.now, signal: options.signal })
  }

  async loadRange(
    instrument: ViopInstrument,
    options: { startDate: string; endDate: string; now: number; signal?: AbortSignal },
  ): Promise<CandleSeries> {
    if (options.startDate > options.endDate) throw new Error("Backtest candle range starts after it ends")
    const to = endOfIstanbulDate(options.endDate)
    const from = startOfIstanbulDate(options.startDate) - WARMUP_LOOKBACK_MS
    const bars = await this.remote.loadFiveMinuteBars(instrument.symbol, from, to, { signal: options.signal })
    const completed = aggregateTenMinuteCandles(bars)
      .filter((candle) => candle.timestamp + TEN_MINUTES_MS <= Math.min(to, options.now))
    await this.history.put(instrument.uid, "MIN_10", completed)
    return {
      instrumentUid: instrument.uid,
      range: "INTRADAY",
      interval: "MIN_10",
      candles: completed,
      availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
      intervalMs: TEN_MINUTES_MS,
      currency: instrument.currency,
    }
  }
}

export function aggregateTenMinuteCandles(bars: HistoricalBar[]): Candle[] {
  const buckets = new Map<number, Map<number, HistoricalBar>>()
  for (const bar of bars) {
    const timestamp = Math.floor(bar.timestamp / TEN_MINUTES_MS) * TEN_MINUTES_MS
    if (bar.timestamp !== timestamp && bar.timestamp !== timestamp + FIVE_MINUTES_MS) continue
    const bucket = buckets.get(timestamp) ?? new Map<number, HistoricalBar>()
    bucket.set(bar.timestamp, bar)
    buckets.set(timestamp, bucket)
  }
  return [...buckets.entries()].flatMap(([timestamp, bucket]) => {
    const first = bucket.get(timestamp)
    const second = bucket.get(timestamp + FIVE_MINUTES_MS)
    if (!first || !second) return []
    return [{
      timestamp,
      open: first.open,
      high: Math.max(first.high, second.high),
      low: Math.min(first.low, second.low),
      close: second.close,
      volume: sumVolume(first.volume, second.volume),
    }]
  }).sort((left, right) => left.timestamp - right.timestamp)
}

function sumVolume(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function endOfIstanbulDate(date: string): number {
  return startOfIstanbulDate(date) + 24 * 60 * 60_000
}

function startOfIstanbulDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid backtest session date: ${date}`)
  const start = Date.parse(`${date}T00:00:00+03:00`)
  if (!Number.isFinite(start)) throw new Error(`Invalid backtest session date: ${date}`)
  return start
}

function istanbulDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp))
}
