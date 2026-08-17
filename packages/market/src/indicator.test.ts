import { expect, test } from "bun:test"
import type { Candle } from "./candle.ts"
import {
  bollingerBands,
  exponentialMovingAverage,
  indicatorLines,
  volumeWeightedAveragePrice,
} from "./indicator.ts"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const START = new Date("2026-08-17T07:00:00Z").getTime()

function bars(closes: number[], stepMs = HOUR_MS, volume: number | null = 100): Candle[] {
  return closes.map((close, index) => ({
    timestamp: START + index * stepMs,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  }))
}

test("an average says nothing until it has a full window behind it", () => {
  const values = exponentialMovingAverage(bars([10, 11, 12, 13]), 3)

  expect(values.slice(0, 2)).toEqual([null, null])
  // Seeded with the simple average of the first three closes.
  expect(values[2]).toBeCloseTo(11, 10)
  // Then weighted: 13 * 0.5 + 11 * 0.5.
  expect(values[3]).toBeCloseTo(12, 10)

  // A series shorter than the period draws nothing at all.
  expect(exponentialMovingAverage(bars([10, 11]), 3)).toEqual([null, null])
})

test("VWAP restarts each session instead of averaging across days", () => {
  // Two candles a day apart: the second day must not inherit the first.
  const candles = bars([100, 200], DAY_MS)
  const values = volumeWeightedAveragePrice(candles)

  expect(values[0]).toBeCloseTo(100, 10)
  expect(values[1]).toBeCloseTo(200, 10)

  // Within one session it is the running volume-weighted mean.
  const session = volumeWeightedAveragePrice(bars([100, 200]))
  expect(session[1]).toBeCloseTo(150, 10)
})

test("VWAP waits for volume rather than drawing a line without it", () => {
  expect(volumeWeightedAveragePrice(bars([100, 200], HOUR_MS, null))).toEqual([null, null])
  expect(volumeWeightedAveragePrice(bars([100, 200], HOUR_MS, 0))).toEqual([null, null])
})

test("bollinger bands sit symmetrically around their average", () => {
  const closes = [10, 12, 14, 12, 10]
  const { upper, middle, lower } = bollingerBands(bars(closes), 5, 2)

  expect(middle.slice(0, 4)).toEqual([null, null, null, null])
  expect(middle[4]).toBeCloseTo(11.6, 10)
  const spread = Math.sqrt(closes.reduce((total, close) => total + (close - 11.6) ** 2, 0) / 5) * 2
  expect(upper[4]).toBeCloseTo(11.6 + spread, 10)
  expect(lower[4]).toBeCloseTo(11.6 - spread, 10)
})

test("draws only the active indicators, and drops VWAP on daily candles", () => {
  const candles = bars(Array.from({ length: 30 }, (_, index) => 100 + index))

  const lines = indicatorLines(candles, ["EMA_20", "VWAP"], HOUR_MS)
  expect(lines.map((line) => line.indicator)).toEqual(["EMA_20", "VWAP"])

  // One session per candle makes VWAP a restatement of that candle.
  expect(indicatorLines(candles, ["VWAP"], DAY_MS)).toEqual([])

  // Bollinger is three lines under one toggle.
  const bands = indicatorLines(candles, ["BOLLINGER"], HOUR_MS)
  expect(bands).toHaveLength(3)
  expect(new Set(bands.map((line) => line.color)).size).toBe(1)

  expect(indicatorLines(candles, [], HOUR_MS)).toEqual([])
  expect(indicatorLines([], ["EMA_20"], HOUR_MS)).toEqual([])
})
