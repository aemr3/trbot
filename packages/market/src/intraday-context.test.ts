import { expect, test } from "bun:test"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleSeries } from "./candle.ts"
import { intradayCandleContext, sessionRelativeStrength } from "./intraday-context.ts"

const MINUTE_MS = 60_000
const PREVIOUS_ONE = Date.parse("2026-08-24T07:00:00Z")
const PREVIOUS_TWO = Date.parse("2026-08-25T07:00:00Z")
const CURRENT = Date.parse("2026-08-26T07:00:00Z")
const AS_OF = CURRENT + 22.5 * MINUTE_MS

test("separates confirmed session context from the forming candle", () => {
  const series = candleSeries([
    ...sessionCandles(PREVIOUS_ONE, 100, 100),
    ...sessionCandles(PREVIOUS_TWO, 200, 150),
    ...sessionCandles(CURRENT, 300, 200),
  ])

  const context = intradayCandleContext(series, AS_OF)

  expect(context).toMatchObject({
    lastCompletedTimestamp: CURRENT + 15 * MINUTE_MS,
    formingTimestamp: CURRENT + 20 * MINUTE_MS,
    previousSession: {
      date: "2026-08-25",
      candleCount: 6,
      open: 200,
      high: 206,
      low: 199,
      close: 205,
      volume: 900,
    },
    currentSession: {
      date: "2026-08-26",
      confirmed: { candleCount: 4, close: 303, volume: 800 },
      provisional: { candleCount: 5, close: 304, volume: 1_000 },
    },
    openingRanges: {
      minutes15: {
        status: "CONFIRMED",
        confirmed: { candleCount: 3, open: 300, high: 303, low: 299, close: 302 },
        provisional: null,
      },
      minutes30: {
        status: "FORMING",
        confirmed: null,
        provisional: { candleCount: 5, close: 304 },
      },
    },
    relativeVolume: {
      confirmed: {
        ratio: 1.6,
        currentVolume: 800,
        averageComparableVolume: 500,
        comparisonBars: 4,
        baselineSessions: 2,
      },
      provisional: {
        ratio: 1.6,
        currentVolume: 1_000,
        averageComparableVolume: 625,
        comparisonBars: 5,
        baselineSessions: 2,
      },
    },
  })
})

test("does not use a future or forming bar for relative strength", () => {
  const target = candleSeries([
    ...sessionCandles(PREVIOUS_TWO, 90, 100),
    ...sessionCandles(CURRENT, 100, 100),
  ])
  const benchmark = candleSeries([
    ...sessionCandles(PREVIOUS_TWO, 190, 100),
    ...sessionCandles(CURRENT, 200, 100).map((candle, index) => ({
      ...candle,
      open: 200 + index * 0.5,
      high: 201 + index * 0.5,
      low: 199 + index * 0.5,
      close: 200 + index * 0.5,
    })),
  ])
  target.candles[10] = { ...target.candles[10]!, close: 999 }
  target.candles[11] = { ...target.candles[11]!, close: 1_500 }

  const strength = sessionRelativeStrength(target, benchmark, AS_OF)

  expect(strength).toMatchObject({
    date: "2026-08-26",
    throughTimestamp: CURRENT + 15 * MINUTE_MS,
  })
  expect(strength?.targetReturnPercent).toBeCloseTo(3)
  expect(strength?.benchmarkReturnPercent).toBeCloseTo(0.75)
  expect(strength?.excessReturnPercentagePoints).toBeCloseTo(2.25)
})

function sessionCandles(start: number, open: number, volume: number): Candle[] {
  return Array.from({ length: 6 }, (_, index) => ({
    timestamp: start + index * 5 * MINUTE_MS,
    open: open + index,
    high: open + index + 1,
    low: open + index - 1,
    close: open + index,
    volume,
  }))
}

function candleSeries(candles: Candle[]): CandleSeries {
  return {
    instrumentUid: "test",
    range: "MONTH",
    interval: "MIN_5",
    candles,
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    intervalMs: 5 * MINUTE_MS,
    currency: "TRY",
  }
}
