import { expect, test } from "bun:test"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  applyLivePrice,
  averageTrueRange,
  closedCandles,
  type Candle,
  type CandleSeries,
} from "./candle.ts"

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

test("holds back the candle that is still forming", () => {
  const value = series()
  value.candles.push({ timestamp: 1_600_000, open: 101, high: 103, low: 100, close: 102, volume: 5 })

  // The second candle closes at 2_200_000.
  expect(closedCandles(value, 2_100_000).map((candle) => candle.timestamp)).toEqual([1_000_000])
  expect(closedCandles(value, 2_200_000).map((candle) => candle.timestamp)).toEqual([1_000_000, 1_600_000])

  // Without an interval the last candle is the forming one.
  expect(closedCandles({ ...value, intervalMs: null }, 2_100_000).map((c) => c.timestamp)).toEqual([1_000_000])
})

test("averages the true range, counting gaps from the previous close", () => {
  // Ranges: 2, 2, 2 … then a gap-up candle whose true range spans the gap.
  const flat: Candle[] = Array.from({ length: 15 }, (_, index) => ({
    timestamp: index * 600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: null,
  }))
  expect(averageTrueRange(flat, 14)).toBeCloseTo(2, 6)

  const gapped: Candle[] = [
    ...flat,
    { timestamp: 15 * 600_000, open: 110, high: 112, low: 109, close: 111, volume: null },
  ]
  // High 112 against the previous close of 100 is a true range of 12, smoothed
  // into a 2.0 average: (2 * 13 + 12) / 14.
  expect(averageTrueRange(gapped, 14)).toBeCloseTo((2 * 13 + 12) / 14, 6)
})

test("reports no ATR when the series is too short", () => {
  const short: Candle[] = Array.from({ length: 10 }, (_, index) => ({
    timestamp: index * 600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: null,
  }))
  expect(averageTrueRange(short, 14)).toBeNull()
  expect(averageTrueRange(short, 9)).toBeCloseTo(2, 6)
  expect(averageTrueRange(short, 0)).toBeNull()
})
