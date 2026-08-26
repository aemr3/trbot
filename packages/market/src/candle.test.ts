import { describe, expect, test } from "bun:test"
import {
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  DEFAULT_INTERVALS_BY_RANGE,
  applyLivePrice,
  averageTrueRange,
  averageTrueRangeSeries,
  closedCandles,
  rangeForInterval,
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

test("aligns ATR values after the full Wilder warm-up window", () => {
  const candles = Array.from({ length: 16 }, (_, index) => ({
    timestamp: index,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }))
  const values = averageTrueRangeSeries(candles, 14)

  expect(values.slice(0, 14)).toEqual(Array.from({ length: 14 }, () => null))
  expect(values[14]).toBe(2)
  expect(values[15]).toBe(2)
})

describe("rangeForInterval", () => {
  /**
   * A range no longer selects the grain — the two are independent — so this only
   * has to be wide enough that an indicator window is satisfied. Too narrow and
   * an ATR silently reports nothing for want of bars.
   */
  test("widens with the grain", () => {
    expect(rangeForInterval("MIN_1")).toBe("INTRADAY")
    expect(rangeForInterval("MIN_15")).toBe("WEEK")
    expect(rangeForInterval("HOUR_1")).toBe("MONTH")
    expect(rangeForInterval("DAY_1")).toBe("YEAR")
    expect(rangeForInterval("MONTH_1")).toBe("ALL")
  })

  test("covers every grain", () => {
    for (const interval of CANDLE_INTERVALS) {
      expect(CANDLE_RANGES).toContain(rangeForInterval(interval))
    }
  })
})

/** A monthly series: July stamped at its first session, August at its own. */
function monthlySeries(): CandleSeries {
  return {
    instrumentUid: "stock-1",
    range: "ALL",
    interval: "MONTH_1",
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    // The nominal width, which is what a chart spaces its axis by. It is not what
    // decides whether a bar has closed.
    intervalMs: 30 * 24 * 60 * 60_000,
    calendarPeriod: "month",
    currency: "TRY",
    candles: [
      { timestamp: Date.parse("2026-07-01T07:00:00Z"), open: 100, high: 110, low: 95, close: 105, volume: 10 },
      { timestamp: Date.parse("2026-08-03T07:00:00Z"), open: 105, high: 120, low: 104, close: 118, volume: 20 },
    ],
  }
}

/**
 * The failure this exists to prevent: a 31-day month treated as closed on the
 * 31st because 30 days had passed, and a month starting on the 3rd held open into
 * the next one. Both let a monthly close-based rule fire on the wrong day.
 */
test("closes a monthly candle on the calendar, not on a nominal width", () => {
  const value = monthlySeries()

  // Deep inside August: July is finished, August is not.
  const midAugust = Date.parse("2026-08-20T10:00:00+03:00")
  expect(closedCandles(value, midAugust).map((candle) => candle.timestamp))
    .toEqual([Date.parse("2026-07-01T07:00:00Z")])

  // The 30-day width would have closed July on the 31st, a day early.
  const lastDayOfJuly = Date.parse("2026-07-31T10:00:00+03:00")
  expect(closedCandles(value, lastDayOfJuly)).toEqual([])

  // And once September opens, August is closed too — even before a new bar prints.
  const september = Date.parse("2026-09-01T10:00:00+03:00")
  expect(closedCandles(value, september)).toHaveLength(2)
})

test("opens a new candle when a price arrives in a later calendar period", () => {
  const value = monthlySeries()
  const september = Date.parse("2026-09-01T10:00:00+03:00")

  expect(applyLivePrice(value, 130, september)).toBeTrue()
  expect(value.candles).toHaveLength(3)
  // Stamped where the print landed, which is how a folded calendar bar is stamped.
  expect(value.candles.at(-1)).toEqual({
    timestamp: september,
    open: 130,
    high: 130,
    low: 130,
    close: 130,
    volume: null,
  })
})

test("extends the forming candle while the price stays inside its period", () => {
  const value = monthlySeries()

  expect(applyLivePrice(value, 130, Date.parse("2026-08-25T10:00:00+03:00"))).toBeTrue()
  expect(value.candles).toHaveLength(2)
  expect(value.candles.at(-1)?.close).toBe(130)
  expect(value.candles.at(-1)?.high).toBe(130)
})
