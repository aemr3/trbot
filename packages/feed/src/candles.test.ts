import { describe, expect, test } from "bun:test"
import { RULE_INTERVALS, rangeForInterval } from "@trbot/market/candle.ts"
import { countbackFor, FeedCandleSource, FeedDataUnavailableError } from "./candles.ts"
import { FeedSession } from "./session.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

const HISTORY = {
  s: "ok",
  t: [1_787_324_880, 1_787_324_940],
  o: [129.5, 129.8],
  h: [130.0, 130.2],
  l: [129.4, 129.7],
  c: [129.8, 129.9],
  v: [1000, 1200],
}

const SYMBOL_INFO = {
  ticker: "GARAN",
  session: "0955-1810",
  timezone: "Europe/Istanbul",
  currency_code: "TRY",
  data_status: "streaming",
  delay: 0,
  pricescale: 100,
}

interface Stub {
  history?: object
  symbols?: object
}

function build(stub: Stub = {}) {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path.endsWith("/auth/token/")) {
        return { status: 200, body: JSON.stringify({ access: "access-1", refresh: "refresh-1" }) }
      }
      if (path.endsWith("/auth/check/")) {
        return {
          status: 200,
          body: JSON.stringify({
            user: { id: 1, stream_token: "stream-1" },
            permissions: [{ action: "read", subject: "prices.realtime" }],
          }),
        }
      }
      if (path.endsWith("/history")) return { status: 200, body: JSON.stringify(stub.history ?? HISTORY) }
      if (path.endsWith("/symbols")) return { status: 200, body: JSON.stringify(stub.symbols ?? SYMBOL_INFO) }
      throw new Error(`unexpected path ${path}`)
    },
  }

  const session = new FeedSession({
    credentials: { username: "trader@example.com", password: "secret" },
    transport,
  })
  const candles = new FeedCandleSource(session, {
    transport,
    baseUrl: "https://feed.test/udf",
    now: () => 1_787_324_940_000,
  })
  return { candles, requests }
}

function historyRequest(requests: FeedRequest[]): URL {
  const request = requests.find((entry) => entry.url.includes("/history"))
  if (!request) throw new Error("no history request was made")
  return new URL(request.url)
}

/** A daily series long enough to fold into weeks and months. */
function dailyHistory(days: number, from = Date.parse("2026-06-01T07:00:00Z")) {
  const t: number[] = []
  const o: number[] = []
  const h: number[] = []
  const l: number[] = []
  const c: number[] = []
  const v: number[] = []
  for (let index = 0; index < days; index++) {
    t.push(Math.floor((from + index * 24 * 3_600_000) / 1000))
    o.push(100 + index)
    h.push(105 + index)
    l.push(95 + index)
    c.push(101 + index)
    v.push(10)
  }
  return { s: "ok", t, o, h, l, c, v }
}

describe("FeedCandleSource", () => {
  test("sends the license token, which is what makes the series live", async () => {
    const { candles, requests } = build()
    await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")

    expect(requests.find((entry) => entry.url.includes("/history"))?.token).toBe("stream-1")
  })

  // The rest of the application works in milliseconds; the feed answers in seconds.
  test("converts bar timestamps to milliseconds", async () => {
    const { candles } = build()
    const series = await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")

    expect(series.candles).toHaveLength(2)
    expect(series.candles[0]).toEqual({
      timestamp: 1_787_324_880_000,
      open: 129.5,
      high: 130.0,
      low: 129.4,
      close: 129.8,
      volume: 1000,
    })
    expect(series.intervalMs).toBe(5 * 60_000)
  })

  /**
   * Only five grains are actually served. The feed's `supported_resolutions`
   * also advertises 30, 240, W, and M, and every one of those is a 400.
   */
  test("requests the native resolution for a grain the feed serves", async () => {
    const cases = [["MIN_1", "1"], ["MIN_5", "5"], ["MIN_15", "15"], ["HOUR_1", "60"], ["DAY_1", "D"]] as const
    for (const [interval, resolution] of cases) {
      const { candles, requests } = build()
      await candles.loadCandles("GARAN", "MONTH", interval)
      expect(historyRequest(requests).searchParams.get("resolution")).toBe(resolution)
    }
  })

  test("requests a served grain when the asked-for one has to be folded", async () => {
    const cases = [["MIN_30", "15"], ["HOUR_4", "60"], ["WEEK_1", "D"], ["MONTH_1", "D"]] as const
    for (const [interval, resolution] of cases) {
      const { candles, requests } = build({ history: dailyHistory(60) })
      await candles.loadCandles("GARAN", "YEAR", interval)
      expect(historyRequest(requests).searchParams.get("resolution")).toBe(resolution)
    }
  })

  test("reports the grain that was asked for, having folded to it", async () => {
    const { candles } = build({ history: dailyHistory(60) })
    const series = await candles.loadCandles("GARAN", "YEAR", "MIN_30")

    expect(series.interval).toBe("MIN_30")
    expect(series.intervalMs).toBe(30 * 60_000)
  })

  /**
   * A calendar bar has no fixed span — months run 28 to 31 days, and the bar is
   * stamped at its first traded session rather than the period's start. Claiming
   * a duration would let a close-based rule fire on a day the period had not
   * ended, so no duration is claimed and only the newest bar counts as forming.
   */
  test("names the calendar period a folded grain was cut on", async () => {
    const { candles } = build({ history: dailyHistory(60) })

    expect((await candles.loadCandles("GARAN", "YEAR", "WEEK_1")).calendarPeriod).toBe("week")
    expect((await candles.loadCandles("GARAN", "ALL", "MONTH_1")).calendarPeriod).toBe("month")
    // A fixed grain has no period; its width alone says when a bar has closed.
    expect((await candles.loadCandles("GARAN", "YEAR", "MIN_30")).calendarPeriod).toBeNull()
  })

  test("folds daily bars into weekly ones", async () => {
    const { candles } = build({ history: dailyHistory(28) })
    const series = await candles.loadCandles("GARAN", "YEAR", "WEEK_1")

    // Four weeks of five sessions each, from 28 consecutive calendar days.
    expect(series.candles.length).toBeLessThan(28)
    expect(series.candles.length).toBeGreaterThanOrEqual(4)
    const first = series.candles[0]
    expect(first?.open).toBe(100)
  })

  test("folds daily bars into monthly ones", async () => {
    const { candles } = build({ history: dailyHistory(90) })
    const series = await candles.loadCandles("GARAN", "ALL", "MONTH_1")

    expect(series.candles.length).toBeLessThanOrEqual(4)
    expect(series.candles.length).toBeGreaterThanOrEqual(3)
  })

  // Folding four bars into one means asking for four times as many.
  test("scales the request when the grain has to be folded", async () => {
    const { candles, requests } = build({ history: dailyHistory(60) })
    await candles.loadCandles("GARAN", "YEAR", "WEEK_1")

    // 252 sessions / 5 per week = 51 weekly bars, times 5 daily source bars.
    expect(Number(historyRequest(requests).searchParams.get("countback"))).toBe(255)
  })

  /**
   * `countback` overrides the from/to window, so a fixed one made a one-day
   * chart reach back over several sessions at a fine grain.
   */
  test("asks for a bar count that matches the span the range names", async () => {
    const cases = [
      ["INTRADAY", "MIN_5", 106],
      // A BIST session is about nine hours, so one session is nine hourly bars.
      ["INTRADAY", "HOUR_1", 9],
      ["WEEK", "HOUR_1", 45],
      ["YEAR", "DAY_1", 252],
    ] as const

    for (const [range, interval, expected] of cases) {
      const { candles, requests } = build()
      await candles.loadCandles("GARAN", range, interval)
      expect(Number(historyRequest(requests).searchParams.get("countback"))).toBe(expected)
    }
  })

  /**
   * The failure this exists to prevent: a floor sized for an indicator window,
   * which at a coarse grain reaches far past the range. Sixty monthly bars under a
   * heading that says one day is five years of history nobody asked for.
   */
  test("does not reach past the range to satisfy an indicator", async () => {
    const { candles, requests } = build()
    await candles.loadCandles("GARAN", "INTRADAY", "MONTH_1")

    // Two monthly bars, each folded from 22 daily ones.
    expect(Number(historyRequest(requests).searchParams.get("countback"))).toBe(44)
  })

  /**
   * Which is safe because no rule asks for such a pairing: every grain a rule may
   * watch is read over the range `rangeForInterval` gives it, and those are wide
   * enough for an indicator window on their own.
   */
  test("gives every rule grain enough bars for an indicator window", () => {
    for (const interval of RULE_INTERVALS) {
      expect(countbackFor(rangeForInterval(interval), interval)).toBeGreaterThanOrEqual(60)
    }
  })

  test("offers every grain at every range", async () => {
    const { candles } = build()
    const series = await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")

    expect(series.availableIntervalsByRange.INTRADAY).toContain("MONTH_1")
    expect(series.availableIntervalsByRange.ALL).toContain("MIN_1")
  })

  test("returns an empty series when the feed has no data", async () => {
    const { candles } = build({ history: { s: "no_data" } })
    const series = await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")
    expect(series.candles).toEqual([])
  })

  test("raises the feed's own message when it reports an error", async () => {
    const { candles } = build({ history: { s: "error", errmsg: "Yetkiniz bulunmuyor" } })
    await expect(candles.loadCandles("GARAN", "INTRADAY", "MIN_5")).rejects.toThrow(FeedDataUnavailableError)
  })

  test("drops rows that are not fully formed rather than emitting a broken candle", async () => {
    const { candles } = build({
      history: {
        s: "ok",
        t: [1_787_324_880, 1_787_324_940, 1_787_325_000],
        o: [129.5, 129.8, 130.0],
        // The second row inverts high and low; the third is missing a high.
        h: [130.0, 129.0, null],
        l: [129.4, 130.5, 129.9],
        c: [129.8, 129.9, 130.1],
        v: [1000, 1200, null],
      },
    })
    const series = await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")

    expect(series.candles).toHaveLength(1)
    expect(series.candles[0]?.timestamp).toBe(1_787_324_880_000)
  })

  test("returns candles in ascending time order", async () => {
    const { candles } = build({
      history: {
        s: "ok",
        t: [1_787_324_940, 1_787_324_880],
        o: [129.8, 129.5],
        h: [130.2, 130.0],
        l: [129.7, 129.4],
        c: [129.9, 129.8],
        v: [1200, 1000],
      },
    })
    const series = await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")
    expect(series.candles.map((candle) => candle.timestamp)).toEqual([1_787_324_880_000, 1_787_324_940_000])
  })

  test("requests a window bounded by the range", async () => {
    const { candles, requests } = build()
    await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")

    const url = historyRequest(requests)
    const to = Number(url.searchParams.get("to"))
    const from = Number(url.searchParams.get("from"))
    expect(to).toBe(1_787_324_940)
    expect(to - from).toBe(24 * 60 * 60)
  })

  test("reads the delay the feed declares for a symbol", async () => {
    const { candles } = build({
      symbols: { ...SYMBOL_INFO, data_status: "delayed_streaming", delay: 900 },
    })
    const info = await candles.loadSymbolInfo("GARAN")

    expect(info?.delaySeconds).toBe(900)
    expect(info?.delayed).toBe(true)
    expect(info?.session).toBe("0955-1810")
  })

  test("caches symbol metadata rather than re-reading it per candle load", async () => {
    const { candles, requests } = build()
    await candles.loadCandles("GARAN", "INTRADAY", "MIN_5")
    await candles.loadCandles("GARAN", "WEEK", "HOUR_1")

    expect(requests.filter((entry) => entry.url.includes("/symbols"))).toHaveLength(1)
  })
})
