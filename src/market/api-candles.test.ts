import { expect, test } from "bun:test"
import { marketOperations } from "../api/market.ts"
import { ApiCandleSource } from "./api-candles.ts"

test("loads and normalizes advanced stock candle data", async () => {
  const calls: { operation: string; variables: Record<string, unknown> }[] = []
  const client = {
    async call(operation: { name: string }, variables: Record<string, unknown>) {
      calls.push({ operation: operation.name, variables })
      if (operation.name === marketOperations.getInstrument.name) {
        return { instrument: { __typename: "Future", underlyingInstrumentUid: "stock-1" } }
      }
      return {
        advancedChart: {
          data: [
            { o: 103, h: 106, l: 102, c: 105, d: 2000, v2: 20, ed: 3000, m: false },
            { o: 100, h: 104, l: 99, c: 103, d: 1000, v2: 10, ed: 2000, m: false },
            { o: 99, h: 99, l: 99, c: 99, d: null, v2: 0, ed: null, m: true },
          ],
          timeRange: "WEEK",
          selectedInterval: { id: "HOUR_1", displayName: "1 saat" },
          availableIntervalsByTimeRange: [
            {
              timeRange: "WEEK",
              intervals: [
                { id: "MIN_10", displayName: "10 dakika" },
                { id: "HOUR_1", displayName: "1 saat" },
                { id: "NOT_SUPPORTED", displayName: "invalid" },
              ],
            },
          ],
          intervalMs: 3_600_000,
          currency: "TRY",
        },
      }
    },
  }

  const series = await new ApiCandleSource(client as never).loadCandles("future-1", "WEEK", "HOUR_1")

  expect(calls).toEqual([
    { operation: "getInstrument", variables: { instrumentId: "future-1" } },
    {
      operation: "advancedChart",
      variables: {
        instrumentUid: "stock-1",
        selectedIndicatorIds: [],
        timeRange: "WEEK",
        intervalId: "HOUR_1",
      },
    },
  ])
  expect(series.instrumentUid).toBe("stock-1")
  expect(series.range).toBe("WEEK")
  expect(series.interval).toBe("HOUR_1")
  expect(series.availableIntervalsByRange.WEEK).toEqual(["MIN_10", "HOUR_1"])
  expect(series.intervalMs).toBe(3_600_000)
  expect(series.candles.map((candle) => candle.timestamp)).toEqual([1000, 2000])
  expect(series.candles[1]).toMatchObject({ open: 103, high: 106, low: 102, close: 105, volume: 20 })
})

test("rejects malformed candles without failing the entire series", async () => {
  const client = {
    async call(operation: { name: string }) {
      if (operation.name === marketOperations.getInstrument.name) {
        return { instrument: { __typename: "StockV2", underlyingInstrumentUid: null } }
      }
      return {
        advancedChart: {
          data: [
            { o: 10, h: 9, l: 11, c: 10, d: 1000, v2: 1, ed: null, m: false },
            { o: Number.NaN, h: 12, l: 9, c: 11, d: 2000, v2: 1, ed: null, m: false },
          ],
          timeRange: "INTRADAY",
          selectedInterval: { id: "MIN_5", displayName: "5 dakika" },
          availableIntervalsByTimeRange: [],
          intervalMs: null,
          currency: null,
        },
      }
    },
  }

  const series = await new ApiCandleSource(client as never).loadCandles("future-1", "INTRADAY", "MIN_5")
  expect(series.candles).toEqual([])
})

test("caches the resolved underlying stock uid between range requests", async () => {
  let instrumentCalls = 0
  const chartInstrumentUids: string[] = []
  const client = {
    async call(operation: { name: string }, variables: { instrumentUid?: string; timeRange?: string }) {
      if (operation.name === marketOperations.getInstrument.name) {
        instrumentCalls++
        return { instrument: { __typename: "Future", underlyingInstrumentUid: "stock-1" } }
      }
      chartInstrumentUids.push(variables.instrumentUid ?? "")
      return {
        advancedChart: {
          data: [],
          timeRange: variables.timeRange,
          selectedInterval: null,
          availableIntervalsByTimeRange: [],
          intervalMs: 600_000,
          currency: "TRY",
        },
      }
    },
  }
  const source = new ApiCandleSource(client as never)

  await source.loadCandles("future-1", "INTRADAY", "MIN_5")
  await source.loadCandles("future-1", "WEEK", "HOUR_1")

  expect(instrumentCalls).toBe(1)
  expect(chartInstrumentUids).toEqual(["stock-1", "stock-1"])
})
