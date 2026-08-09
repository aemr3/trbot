import type { ApiClient } from "../api/index.ts"
import { marketOperations } from "../api/market.ts"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  isCandleInterval,
  isCandleRange,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "./candle.ts"

type MarketApiClient = Pick<ApiClient, "call">

export class ApiCandleSource implements CandleSource {
  private readonly chartInstrumentUids = new Map<string, string>()

  constructor(private readonly client: MarketApiClient) {}

  async loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
    options: { signal?: AbortSignal } = {},
  ): Promise<CandleSeries> {
    const chartInstrumentUid = await this.resolveChartInstrumentUid(instrumentUid, options.signal)
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

  private async resolveChartInstrumentUid(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const cached = this.chartInstrumentUids.get(instrumentUid)
    if (cached) return cached
    const data = await this.client.call(marketOperations.getInstrument, { instrumentId: instrumentUid }, { signal })
    const chartInstrumentUid = data.instrument?.underlyingInstrumentUid ?? instrumentUid
    this.chartInstrumentUids.set(instrumentUid, chartInstrumentUid)
    return chartInstrumentUid
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
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
