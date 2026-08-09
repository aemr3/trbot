import { expect, test } from "bun:test"
import { DEFAULT_INTERVALS_BY_RANGE, applyLivePrice, type CandleSeries } from "./candle.ts"

function series(): CandleSeries {
  return {
    instrumentUid: "stock-1",
    range: "INTRADAY",
    interval: "MIN_5",
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    intervalMs: 600_000,
    currency: "TRY",
    candles: [{ timestamp: 1_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10 }],
  }
}

test("applies a live price to the active candle", () => {
  const value = series()

  expect(applyLivePrice(value, 104, 1_300_000)).toBeTrue()
  expect(value.candles).toEqual([
    { timestamp: 1_000_000, open: 100, high: 104, low: 99, close: 104, volume: 10 },
  ])
})

test("starts a new candle after the current interval", () => {
  const value = series()

  expect(applyLivePrice(value, 105, 1_700_000)).toBeTrue()
  expect(value.candles.at(-1)).toEqual({
    timestamp: 1_600_000,
    open: 105,
    high: 105,
    low: 105,
    close: 105,
    volume: null,
  })
})
