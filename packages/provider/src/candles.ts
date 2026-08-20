import type { ApiClient } from "@trbot/api"
import { marketOperations } from "@trbot/api/market.ts"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  FUTURES_INTERVALS_BY_RANGE,
  isCandleInterval,
  isCandleRange,
  type Candle,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "@trbot/market/candle.ts"

type MarketApiClient = Pick<ApiClient, "call">

const INTERVAL_BY_DURATION_MS = new Map<number, CandleInterval>([
  [5 * 60_000, "MIN_5"],
  [10 * 60_000, "MIN_10"],
  [15 * 60_000, "MIN_15"],
  [30 * 60_000, "MIN_30"],
  [60 * 60_000, "HOUR_1"],
  [4 * 60 * 60_000, "HOUR_4"],
  [24 * 60 * 60_000, "DAY_1"],
  [7 * 24 * 60 * 60_000, "WEEK_1"],
  [30 * 24 * 60 * 60_000, "MONTH_1"],
])

interface IndexSymbols {
  [target: string]: string | undefined
}

const INDEX_SYMBOL_BY_TARGET: IndexSymbols = {
  BIST_100: "XU100",
  BIST_30: "XU030",
}

export class ApiCandleSource implements CandleSource {
  private readonly chartInstrumentUids = new Map<string, string>()
  private readonly indexInstrumentUids = new Map<string, string>()

  constructor(private readonly client: MarketApiClient) {}

  async loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
    options: { signal?: AbortSignal; target?: CandleChartTarget } = {},
  ): Promise<CandleSeries> {
    if (options.target === "INSTRUMENT") {
      return this.loadInstrumentCandles(instrumentUid, range, options.signal)
    }
    const indexSymbol = options.target ? INDEX_SYMBOL_BY_TARGET[options.target] : undefined
    const chartInstrumentUid = indexSymbol
      ? await this.resolveIndexInstrumentUid(indexSymbol, options.signal)
      : await this.resolveChartInstrumentUid(instrumentUid, options.signal)
    const data = await this.client.call(
      marketOperations.advancedChart,
      { instrumentUid: chartInstrumentUid, selectedIndicatorIds: [], timeRange: range, intervalId: interval },
      options,
    )
    const chart = data.advancedChart
    const returnedRange = chart?.timeRange && isCandleRange(chart.timeRange) ? chart.timeRange : range
    const returnedInterval = chart?.selectedInterval?.id && isCandleInterval(chart.selectedInterval.id)
      ? chart.selectedInterval.id
      : interval
    const availableIntervalsByRange = { ...DEFAULT_INTERVALS_BY_RANGE }
    for (const available of chart?.availableIntervalsByTimeRange ?? []) {
      if (!isCandleRange(available.timeRange)) continue
      availableIntervalsByRange[available.timeRange] = available.intervals
        .map((item) => item.id)
        .filter(isCandleInterval)
    }

    return {
      instrumentUid: chartInstrumentUid,
      range: returnedRange,
      interval: returnedInterval,
      candles: (chart?.data ?? []).flatMap(toCandle).sort((left, right) => left.timestamp - right.timestamp),
      availableIntervalsByRange,
      intervalMs: finiteNumber(chart?.intervalMs),
      currency: chart?.currency ?? null,
    }
  }

  private async loadInstrumentCandles(
    instrumentUid: string,
    range: CandleRange,
    signal?: AbortSignal,
  ): Promise<CandleSeries> {
    const requestedRange = range === "YEAR" || range === "FIVE_YEAR" ? "ALL_TIME" : range
    const data = await this.client.call(
      marketOperations.candlestickChartV2,
      { instrumentId: instrumentUid, timeRange: requestedRange, currency: "TRY" },
      { signal },
    )
    const chart = data.candlestickChartV2
    const intervalMs = finiteNumber(chart?.intervalMs)
    const interval = (intervalMs === null ? undefined : INTERVAL_BY_DURATION_MS.get(intervalMs))
      ?? FUTURES_INTERVALS_BY_RANGE[range][0]
      ?? DEFAULT_INTERVALS_BY_RANGE[range][0]
      ?? "DAY_1"

    return {
      instrumentUid,
      range,
      interval,
      candles: (chart?.data ?? [])
        .flatMap((entry) => toCandle({ ...entry, v2: entry.v }))
        .sort((left, right) => left.timestamp - right.timestamp),
      availableIntervalsByRange: FUTURES_INTERVALS_BY_RANGE,
      intervalMs,
      currency: chart?.currency ?? null,
    }
  }

  private async resolveChartInstrumentUid(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const cached = this.chartInstrumentUids.get(instrumentUid)
    if (cached) return cached
    const data = await this.client.call(marketOperations.getInstrument, { instrumentId: instrumentUid }, { signal })
    const chartInstrumentUid = data.instrument?.underlyingInstrumentUid ?? instrumentUid
    this.chartInstrumentUids.set(instrumentUid, chartInstrumentUid)
    return chartInstrumentUid
  }

  private async resolveIndexInstrumentUid(symbol: string, signal?: AbortSignal): Promise<string> {
    const cached = this.indexInstrumentUids.get(symbol)
    if (cached) return cached
    const data = await this.client.call(
      marketOperations.searchByAdvancedTools,
      { query: symbol, tool: "ADVANCED_CHART", page: 0, size: 10 },
      { signal },
    )
    const instrument = data.searchByAdvancedTools?.results.find(
      (result) => result.symbol?.toUpperCase() === symbol,
    )
    if (!instrument) throw new Error(`${symbol} index is unavailable`)
    this.indexInstrumentUids.set(symbol, instrument.uid)
    return instrument.uid
  }
}

function toCandle(raw: {
  o: number
  h: number
  l: number
  c: number
  d: number | null
  v2: number | null
}): Candle[] {
  const values = [raw.o, raw.h, raw.l, raw.c]
  if (raw.d === null || !Number.isFinite(raw.d) || values.some((value) => !Number.isFinite(value))) return []
  if (raw.h < raw.l) return []
  return [{ timestamp: raw.d, open: raw.o, high: raw.h, low: raw.l, close: raw.c, volume: finiteNumber(raw.v2) }]
}

function finiteNumber(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null
}
