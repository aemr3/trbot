import { describe, expect, test } from "bun:test"
import type { Candle } from "@trbot/market/candle.ts"
import { aggregateByCalendar, aggregateByDuration } from "./aggregate.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function candle(iso: string, open: number, high: number, low: number, close: number, volume: number | null): Candle {
  return { timestamp: Date.parse(iso), open, high, low, close, volume }
}

describe("aggregateByDuration", () => {
  // 15-minute bars land on :00/:15/:30/:45, so pairs fold into exact half hours.
  test("folds two quarter hours into a half hour", () => {
    const folded = aggregateByDuration([
      candle("2026-08-21T07:00:00Z", 100, 104, 99, 103, 10),
      candle("2026-08-21T07:15:00Z", 103, 108, 102, 107, 20),
    ], 30 * MINUTE)

    expect(folded).toEqual([
      { timestamp: Date.parse("2026-08-21T07:00:00Z"), open: 100, high: 108, low: 99, close: 107, volume: 30 },
    ])
  })

  test("starts a new bar at each bucket boundary", () => {
    const folded = aggregateByDuration([
      candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, 1),
      candle("2026-08-21T07:15:00Z", 100, 102, 100, 101, 1),
      candle("2026-08-21T07:30:00Z", 101, 103, 101, 102, 1),
      candle("2026-08-21T07:45:00Z", 102, 104, 102, 103, 1),
    ], 30 * MINUTE)

    expect(folded.map((entry) => entry.timestamp)).toEqual([
      Date.parse("2026-08-21T07:00:00Z"),
      Date.parse("2026-08-21T07:30:00Z"),
    ])
    expect(folded.map((entry) => entry.close)).toEqual([101, 103])
  })

  test("folds hourly bars into four-hour buckets", () => {
    const folded = aggregateByDuration([
      candle("2026-08-21T08:00:00Z", 10, 12, 9, 11, 5),
      candle("2026-08-21T09:00:00Z", 11, 15, 10, 14, 5),
      candle("2026-08-21T10:00:00Z", 14, 16, 13, 15, 5),
      candle("2026-08-21T11:00:00Z", 15, 17, 14, 16, 5),
      candle("2026-08-21T12:00:00Z", 16, 18, 15, 17, 5),
    ], 4 * HOUR)

    expect(folded).toHaveLength(2)
    expect(folded[0]).toEqual({
      timestamp: Date.parse("2026-08-21T08:00:00Z"),
      open: 10,
      high: 17,
      low: 9,
      close: 16,
      volume: 20,
    })
    expect(folded[1]?.timestamp).toBe(Date.parse("2026-08-21T12:00:00Z"))
  })

  test("keeps a lone trailing bar", () => {
    const folded = aggregateByDuration([candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, 1)], 30 * MINUTE)
    expect(folded).toHaveLength(1)
  })

  // A bar with no volume must not be reported as a bar with zero volume.
  test("keeps volume null when no part of the bucket reported any", () => {
    const folded = aggregateByDuration([
      candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, null),
      candle("2026-08-21T07:15:00Z", 100, 102, 100, 101, null),
    ], 30 * MINUTE)

    expect(folded[0]?.volume).toBeNull()
  })

  test("sums the volume that was reported", () => {
    const folded = aggregateByDuration([
      candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, null),
      candle("2026-08-21T07:15:00Z", 100, 102, 100, 101, 7),
    ], 30 * MINUTE)

    expect(folded[0]?.volume).toBe(7)
  })

  test("returns the input unchanged for a meaningless bucket", () => {
    const input = [candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, 1)]
    expect(aggregateByDuration(input, 0)).toEqual(input)
  })

  test("folds nothing into nothing", () => {
    expect(aggregateByDuration([], 30 * MINUTE)).toEqual([])
  })
})

describe("aggregateByCalendar", () => {
  /**
   * A week is cut on the exchange's Monday, not on a fixed 7-day stride from the
   * epoch, so a week that starts mid-series still groups correctly.
   */
  test("groups a trading week onto one bar", () => {
    // Monday 17th through Friday 21st August 2026, Istanbul.
    const folded = aggregateByCalendar([
      candle("2026-08-17T07:00:00Z", 100, 105, 99, 104, 10),
      candle("2026-08-18T07:00:00Z", 104, 109, 103, 108, 10),
      candle("2026-08-19T07:00:00Z", 108, 110, 106, 107, 10),
      candle("2026-08-20T07:00:00Z", 107, 112, 105, 111, 10),
      candle("2026-08-21T07:00:00Z", 111, 115, 110, 113, 10),
    ], "week")

    expect(folded).toHaveLength(1)
    expect(folded[0]).toEqual({
      timestamp: Date.parse("2026-08-17T07:00:00Z"),
      open: 100,
      high: 115,
      low: 99,
      close: 113,
      volume: 50,
    })
  })

  test("splits consecutive weeks", () => {
    const folded = aggregateByCalendar([
      candle("2026-08-20T07:00:00Z", 100, 101, 99, 100, 1),
      candle("2026-08-21T07:00:00Z", 100, 102, 100, 101, 1),
      // The following Monday starts a new week.
      candle("2026-08-24T07:00:00Z", 101, 103, 101, 102, 1),
    ], "week")

    expect(folded).toHaveLength(2)
    expect(folded[1]?.timestamp).toBe(Date.parse("2026-08-24T07:00:00Z"))
  })

  // Sunday is the end of the exchange's week, not the start of the next one.
  test("keeps a Sunday with the week that precedes it", () => {
    const folded = aggregateByCalendar([
      candle("2026-08-21T07:00:00Z", 100, 101, 99, 100, 1),
      candle("2026-08-23T07:00:00Z", 100, 105, 100, 104, 1),
      candle("2026-08-24T07:00:00Z", 104, 106, 103, 105, 1),
    ], "week")

    expect(folded).toHaveLength(2)
    expect(folded[0]?.close).toBe(104)
  })

  /** A holiday Monday must not stamp the bar to a day that never traded. */
  test("stamps a week with its first traded session", () => {
    const folded = aggregateByCalendar([
      candle("2026-08-18T07:00:00Z", 104, 109, 103, 108, 10),
      candle("2026-08-19T07:00:00Z", 108, 110, 106, 107, 10),
    ], "week")

    expect(folded[0]?.timestamp).toBe(Date.parse("2026-08-18T07:00:00Z"))
  })

  test("groups a calendar month onto one bar", () => {
    const folded = aggregateByCalendar([
      candle("2026-07-01T07:00:00Z", 50, 55, 49, 54, 1),
      candle("2026-07-31T07:00:00Z", 54, 60, 53, 58, 1),
      candle("2026-08-03T07:00:00Z", 58, 62, 57, 61, 1),
    ], "month")

    expect(folded).toHaveLength(2)
    expect(folded[0]).toEqual({
      timestamp: Date.parse("2026-07-01T07:00:00Z"),
      open: 50,
      high: 60,
      low: 49,
      close: 58,
      volume: 2,
    })
    expect(folded[1]?.open).toBe(58)
  })

  test("splits December from the January that follows", () => {
    const folded = aggregateByCalendar([
      candle("2026-12-30T07:00:00Z", 10, 11, 9, 10, 1),
      candle("2027-01-04T07:00:00Z", 10, 12, 10, 11, 1),
    ], "month")

    expect(folded).toHaveLength(2)
  })

  /**
   * A bar timestamped just before midnight UTC falls on the next day in
   * Istanbul, so grouping in UTC would put it in the wrong month.
   */
  test("cuts periods on the exchange's clock, not UTC", () => {
    const folded = aggregateByCalendar([
      // 21:30 UTC on 31 July is 00:30 on 1 August in Istanbul.
      candle("2026-07-31T21:30:00Z", 10, 11, 9, 10, 1),
      candle("2026-08-05T07:00:00Z", 10, 12, 10, 11, 1),
    ], "month")

    expect(folded).toHaveLength(1)
  })

  test("folds nothing into nothing", () => {
    expect(aggregateByCalendar([], "week")).toEqual([])
  })
})
