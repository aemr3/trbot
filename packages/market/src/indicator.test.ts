import { expect, test } from "bun:test"
import type { Candle } from "./candle.ts"
import {
  CANDLE_INDICATORS,
  CHART_INDICATORS,
  ChartIndicatorCache,
  bollingerBands,
  candleIndicatorSeries,
  dailyClassicPivotLevels,
  exponentialMovingAverage,
  indicatorLines,
  movingAverageConvergenceDivergence,
  relativeStrengthIndex,
  relativeVolumeSeries,
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

test("VWAP restarts each exchange-local date instead of averaging across days", () => {
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

test("reuses chart indicators until the candle series changes", () => {
  const candles = bars(Array.from({ length: 30 }, (_, index) => 100 + index))
  const cache = new ChartIndicatorCache()

  const first = cache.lines(candles, ["EMA_20"], HOUR_MS)
  const repeated = cache.lines(candles, ["EMA_20", "VWAP"], HOUR_MS)
  expect(repeated[0]).toBe(first[0])

  candles[candles.length - 1]!.close = 500
  cache.invalidate()
  const refreshed = cache.lines(candles, ["EMA_20"], HOUR_MS)
  expect(refreshed[0]).not.toBe(first[0])
  expect(refreshed[0]?.values.at(-1)).not.toBe(first[0]?.values.at(-1))
})

test("calculates Wilder RSI on the requested candle sequence", () => {
  const rising = relativeStrengthIndex(bars(Array.from({ length: 15 }, (_, index) => 100 + index)), 14)
  expect(rising.slice(0, 14)).toEqual(Array.from({ length: 14 }, () => null))
  expect(rising[14]).toBe(100)

  const flat = relativeStrengthIndex(bars(Array.from({ length: 15 }, () => 100)), 14)
  expect(flat[14]).toBe(50)

  const reference = relativeStrengthIndex(bars([
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  ]), 14)
  expect(reference[14]).toBeCloseTo(70.4641, 4)
})

test("aligns MACD and its signal after both warm-up windows", () => {
  const candles = bars(Array.from({ length: 40 }, (_, index) => 100 + index))
  const { macd, signal, histogram } = movingAverageConvergenceDivergence(candles)

  expect(macd.slice(0, 25).every((value) => value === null)).toBe(true)
  expect(macd[25]).toBeCloseTo(7, 10)
  expect(signal.slice(0, 33).every((value) => value === null)).toBe(true)
  expect(signal[33]).toBeCloseTo(7, 10)
  expect(histogram[33]).toBeCloseTo(0, 10)
})

test("projects the prior trading date across every candle in the current date", () => {
  const previous = bars([100], DAY_MS)
  previous[0] = { ...previous[0]!, high: 110, low: 90, close: 100 }
  const current = bars([500, 505]).map((candle, index) => ({
    ...candle,
    timestamp: candle.timestamp + DAY_MS + index * HOUR_MS,
  }))
  const levels = dailyClassicPivotLevels([...previous, ...current])

  expect(levels.pivot).toEqual([null, 100, 100])
  expect(levels.r1.slice(1)).toEqual([110, 110])
  expect(levels.r2.slice(1)).toEqual([120, 120])
  expect(levels.r3.slice(1)).toEqual([130, 130])
  expect(levels.s1.slice(1)).toEqual([90, 90])
  expect(levels.s2.slice(1)).toEqual([80, 80])
  expect(levels.s3.slice(1)).toEqual([70, 70])
})

test("relative volume compares each bar with the same time of day in prior sessions", () => {
  const sessionBars = (day: number, volumes: number[]): Candle[] =>
    volumes.map((volume, index) => ({
      timestamp: START + day * DAY_MS + index * HOUR_MS,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume,
    }))
  const candles = [
    ...sessionBars(0, [100, 100, 100]),
    ...sessionBars(1, [300, 100, 100]),
    ...sessionBars(2, [400, 400, 400]),
  ]

  const values = relativeVolumeSeries(candles)

  // The first session has no prior session to compare with.
  expect(values.slice(0, 3)).toEqual([null, null, null])
  // Session two: 300 vs 100, then cumulative 400 vs 200, then 500 vs 300.
  expect(values[3]).toBeCloseTo(3, 10)
  expect(values[4]).toBeCloseTo(2, 10)
  expect(values[5]).toBeCloseTo(500 / 300, 10)
  // Session three averages both prior sessions bar for bar: 400 vs (100 + 300) / 2.
  expect(values[6]).toBeCloseTo(2, 10)
  expect(values[8]).toBeCloseTo(1_200 / 400, 10)
})

test("relative volume skips prior sessions that are shorter or missing volume", () => {
  const shortPrior = [
    { timestamp: START, open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { timestamp: START + DAY_MS, open: 100, high: 101, low: 99, close: 100, volume: 200 },
    { timestamp: START + DAY_MS + HOUR_MS, open: 100, high: 101, low: 99, close: 100, volume: 200 },
  ]
  const values = relativeVolumeSeries(shortPrior)
  expect(values[1]).toBeCloseTo(2, 10)
  // The prior session never reached a second bar, so the second bar has no baseline.
  expect(values[2]).toBeNull()

  const unreported = relativeVolumeSeries([
    { timestamp: START, open: 100, high: 101, low: 99, close: 100, volume: null },
    { timestamp: START + DAY_MS, open: 100, high: 101, low: 99, close: 100, volume: 200 },
  ])
  expect(unreported).toEqual([null, null])
})

test("keeps agent-only indicators outside the chart indicator set", () => {
  const candles = bars(Array.from({ length: 40 }, (_, index) => 100 + index))
  const result = candleIndicatorSeries(candles, ["EMA_20", "ATR_14", "RSI_14", "MACD", "PIVOT_DAILY_CLASSIC"], HOUR_MS)

  expect(result.map((indicator) => indicator.indicator)).toEqual([
    "EMA_20",
    "ATR_14",
    "RSI_14",
    "MACD",
    "PIVOT_DAILY_CLASSIC",
  ])
  expect(result.find((indicator) => indicator.indicator === "ATR_14")?.lines.atr).toHaveLength(candles.length)
  expect(result.find((indicator) => indicator.indicator === "MACD")?.availability.firstAvailableIndex).toBe(33)
  expect(CHART_INDICATORS).toEqual(["EMA_20", "EMA_50", "EMA_100", "VWAP", "BOLLINGER"])
  expect(CANDLE_INDICATORS).toContain("PIVOT_DAILY_CLASSIC")
})

test("reports when an indicator has not received enough bars", () => {
  const [indicator] = candleIndicatorSeries(bars(Array.from({ length: 30 }, () => 100)), ["EMA_100"], HOUR_MS)

  expect(indicator?.availability).toEqual({ firstAvailableIndex: null, latestAvailableIndex: null })
})
