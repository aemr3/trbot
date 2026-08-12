import { expect, test } from "bun:test"
import type { HistoricalBarSource } from "../api/historical-bars.ts"
import type { Candle } from "./candle.ts"
import {
  aggregateTenMinuteCandles,
  HistoricalBacktestCandleSource,
  type CandleHistoryStore,
} from "./candle-history.ts"
import type { ViopInstrument } from "./instrument.ts"

test("uses only the current historical response for a backtest candle series", async () => {
  const start = Date.parse("2026-08-10T06:20:00.000Z")
  const stored = [candle(start - 600_000, 99)]
  const history: CandleHistoryStore = {
    async put(_uid, _interval, candles) {
      for (const item of candles) {
        const index = stored.findIndex((existing) => existing.timestamp === item.timestamp)
        if (index === -1) stored.push(item)
        else stored[index] = item
      }
    },
    async list() { throw new Error("persisted candles must not be read into the current replay") },
  }
  const remote: HistoricalBarSource = {
    async loadFiveMinuteBars() {
      return [
        { timestamp: start, open: 100, high: 103, low: 99, close: 102, volume: 10 },
        { timestamp: start + 300_000, open: 102, high: 105, low: 101, close: 104, volume: 20 },
      ]
    },
  }

  const result = await new HistoricalBacktestCandleSource(remote, history).loadCandles(instrument, {
    sessionDate: "2026-08-10",
    now: Date.parse("2026-08-11T10:00:00.000Z"),
  })

  expect(result.candles).toEqual([
    { timestamp: start, open: 100, high: 105, low: 99, close: 104, volume: 30 },
  ])
  expect(stored).toContainEqual(result.candles[0]!)
})

test("aggregates five-minute history into ten-minute OHLCV candles", () => {
  const start = Date.parse("2026-08-10T06:20:00.000Z")
  expect(aggregateTenMinuteCandles([
    { timestamp: start, open: 100, high: 103, low: 99, close: 102, volume: 10 },
    { timestamp: start + 300_000, open: 102, high: 105, low: 101, close: 104, volume: 20 },
    { timestamp: start + 600_000, open: 104, high: 106, low: 103, close: 105, volume: null },
    { timestamp: start + 900_000, open: 105, high: 107, low: 102, close: 103, volume: 30 },
  ])).toEqual([
    { timestamp: start, open: 100, high: 105, low: 99, close: 104, volume: 30 },
    { timestamp: start + 600_000, open: 104, high: 107, low: 102, close: 103, volume: 30 },
  ])
})

test("drops a ten-minute candle when either five-minute component is missing", () => {
  const start = Date.parse("2026-08-10T06:20:00.000Z")
  expect(aggregateTenMinuteCandles([
    { timestamp: start, open: 100, high: 103, low: 99, close: 102, volume: 10 },
    { timestamp: start + 600_000, open: 104, high: 106, low: 103, close: 105, volume: 20 },
    { timestamp: start + 900_000, open: 105, high: 107, low: 102, close: 103, volume: 30 },
  ])).toEqual([
    { timestamp: start + 600_000, open: 104, high: 107, low: 102, close: 103, volume: 50 },
  ])
})

test("backfills the selected session and prior warm-up candles into persistent history", async () => {
  const calls: Array<{ symbol: string; from: number; to: number }> = []
  const start = Date.parse("2026-08-10T06:20:00.000Z")
  const remote: HistoricalBarSource = {
    async loadFiveMinuteBars(symbol, from, to) {
      calls.push({ symbol, from, to })
      return [
        { timestamp: start, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { timestamp: start + 300_000, open: 101, high: 103, low: 100, close: 102, volume: 20 },
      ]
    },
  }
  const writes: Candle[] = []
  const history: CandleHistoryStore = {
    async put(_uid, _interval, candles) { writes.push(...candles) },
    async list() { return [] },
  }
  await new HistoricalBacktestCandleSource(remote, history).loadCandles(instrument, {
    sessionDate: "2026-08-10",
    now: Date.parse("2026-08-11T10:00:00.000Z"),
  })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.symbol).toBe("F_THYAO0826")
  expect(calls[0]?.to).toBe(Date.parse("2026-08-11T00:00:00+03:00"))
  expect(calls[0]!.to - calls[0]!.from).toBe(22 * 24 * 60 * 60_000)
  expect(writes).toEqual([
    { timestamp: start, open: 100, high: 103, low: 99, close: 102, volume: 30 },
  ])
})

function candle(timestamp: number, close: number): Candle {
  return { timestamp, open: close - 1, high: close + 1, low: close - 2, close, volume: 100 }
}

const instrument: ViopInstrument = {
  uid: "future-1",
  symbol: "F_THYAO0826",
  displayName: "THYAO",
  underlyingSymbol: "THYAO",
  lastPrice: 312,
  changePercent: 1,
  volume: 1_000,
  currency: "TRY",
}
