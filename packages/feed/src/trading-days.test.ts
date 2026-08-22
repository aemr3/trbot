import { describe, expect, test } from "bun:test"
import type { CandleSeries, CandleSource } from "@trbot/market/candle.ts"
import { FeedTradingDays, tradingDayPresets } from "./trading-days.ts"

const NOW = Date.parse("2026-08-21T12:00:00Z")

// Two sessions, the first of them delivered as two intraday-stamped bars, which
// is what a folded daily series can look like.
const TIMESTAMPS = [
  Date.parse("2026-08-20T07:00:00Z"),
  Date.parse("2026-08-20T14:00:00Z"),
  Date.parse("2026-08-21T07:00:00Z"),
]

function build(timestamps = TIMESTAMPS) {
  const asked: { symbol: string; range: string; interval: string }[] = []
  const candles: Pick<CandleSource, "loadCandles"> = {
    async loadCandles(symbol, range, interval): Promise<CandleSeries> {
      asked.push({ symbol, range, interval })
      return {
        instrumentUid: symbol,
        range,
        interval,
        candles: timestamps.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
        availableIntervalsByRange: {
          INTRADAY: [], WEEK: [], MONTH: [], THREE_MONTH: [], YEAR: [], FIVE_YEAR: [], ALL: [],
        },
        intervalMs: null,
        currency: "TRY",
      }
    },
  }
  return { asked, subject: new FeedTradingDays(candles, { now: () => NOW }) }
}

describe("FeedTradingDays", () => {
  test("reads the days from the daily bars, newest first and once each", async () => {
    const { subject, asked } = build()

    expect(await subject.list("GARAN")).toEqual(["2026-08-21", "2026-08-20"])
    expect(asked).toEqual([{ symbol: "GARAN", range: "FIVE_YEAR", interval: "DAY_1" }])
  })

  test("reuses a symbol's days and reads each symbol on its own", async () => {
    const { subject, asked } = build()
    await subject.list("GARAN")
    await subject.list("GARAN")
    await subject.list("THYAO")

    expect(asked.map((entry) => entry.symbol)).toEqual(["GARAN", "THYAO"])
  })

  // Concurrent panels are the norm — the tabs load together — and they must not
  // each start their own year of history.
  test("shares one read between concurrent callers", async () => {
    const { subject, asked } = build()
    await Promise.all([subject.list("GARAN"), subject.list("GARAN"), subject.list("GARAN")])

    expect(asked).toHaveLength(1)
  })
})

describe("tradingDayPresets", () => {
  const dates = Array.from({ length: 70 }, (_, index) => `2026-0${index < 30 ? "8" : "7"}-01`)

  test("keeps the current session as a null range", () => {
    const [current] = tradingDayPresets(dates)

    // Null follows the session over a rollover; a date would pin the reading to
    // the day the picker was opened.
    expect(current).toEqual({ range: { start: null, end: null }, isDefault: true })
  })

  test("offers only the spans the history reaches", () => {
    const short = tradingDayPresets(["2026-08-21", "2026-08-20"])
    const long = tradingDayPresets(dates)

    expect(short).toHaveLength(1)
    expect(long).toHaveLength(4)
  })

  test("offers nothing but the session when there are no days at all", () => {
    expect(tradingDayPresets([])).toEqual([{ range: { start: null, end: null }, isDefault: true }])
  })
})
