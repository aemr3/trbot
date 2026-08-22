import { describe, expect, test } from "bun:test"
import type { CandleSeries, CandleSource } from "@trbot/market/candle.ts"
import type { ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"
import { FeedBrokerageDistributionSource } from "./brokerage.ts"
import { FeedBrokerageDirectory } from "./brokerages.ts"
import { InstrumentSymbols } from "./instrument-symbols.ts"
import { FeedTradingDays } from "./trading-days.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

// One reading of the distribution, as the feed answers it: both sides at once,
// signed, ranked by net size.
const READING = {
  start: "2026-08-21 00:00:00",
  end: "2026-08-21 00:00:00",
  results: [
    { brokerage: "ZRY", net: { size: 600, cost: 131.25, percentage: 0.6 }, total: { size: 1_400, volume: 100, cost: 130.6, percentage: 0.4 } },
    { brokerage: "TAC", net: { size: 300, cost: 130.78, percentage: 0.3 }, total: { size: 3_900, volume: 200, cost: 130.6, percentage: 0.3 } },
    { brokerage: "GCM", net: { size: 100, cost: 129.98, percentage: 0.1 }, total: { size: 900, volume: 50, cost: 129.8, percentage: 0.1 } },
    { brokerage: "OYA", net: { size: -400, cost: 130.98, percentage: 0.4 }, total: { size: 4_900, volume: 300, cost: 130.6, percentage: 0.2 } },
    { brokerage: "ZZZ", net: { size: -600, cost: 129.02, percentage: 0.6 }, total: { size: 500, volume: 20, cost: 129.0, percentage: 0.1 } },
    // A house that bought and sold the same amount, exactly as the feed sends
    // it: no net position, so no price to average.
    { brokerage: "AMK", net: { size: 0, cost: null, percentage: 0 }, total: { size: 4_200, volume: 388_000, cost: 92.381, percentage: 0 } },
  ],
}

const BROKERAGES = [
  { code: "ZRY", title: "Ziraat Yatırım", short_title: "Ziraat" },
  { code: "TAC", title: "Tacirler Yatırım", short_title: "Tacirler" },
  { code: "OYA", title: "Oyak Yatırım", short_title: "Oyak" },
  { code: "GCM", title: "GCM Yatırım", short_title: null },
]

const CONTRACT: ViopInstrument = {
  uid: "viop-ftr-garan",
  symbol: "F_GARAN0826",
  displayName: "GARAN",
  underlyingSymbol: "GARAN",
  lastPrice: null,
  changePercent: null,
  volume: null,
  currency: "TRY",
}

// Two sessions of daily bars, which is where the trading-day calendar comes from.
const SESSIONS = [Date.parse("2026-08-20T07:00:00Z"), Date.parse("2026-08-21T07:00:00Z")]

const NOW = Date.parse("2026-08-21T12:00:00Z")

function build(sessions: number[] = SESSIONS) {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path.endsWith("/akd")) return { status: 200, body: JSON.stringify(READING) }
      if (path.endsWith("/brokerages/")) return { status: 200, body: JSON.stringify(BROKERAGES) }
      throw new Error(`unexpected path ${path}`)
    },
  }

  const candles: Pick<CandleSource, "loadCandles"> = {
    async loadCandles(symbol, range, interval): Promise<CandleSeries> {
      return {
        instrumentUid: symbol,
        range,
        interval,
        candles: sessions.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
        availableIntervalsByRange: {
          INTRADAY: [], WEEK: [], MONTH: [], THREE_MONTH: [], YEAR: [], FIVE_YEAR: [], ALL: [],
        },
        intervalMs: null,
        currency: "TRY",
      }
    },
  }

  const instruments: ViopInstrumentSource = { async listInstruments(): Promise<ViopInstrument[]> { return [CONTRACT] } }
  const session = { streamToken: async () => "licence-1", renewStreamToken: async () => "licence-2" }

  return {
    requests,
    subject: new FeedBrokerageDistributionSource({
      session,
      symbols: new InstrumentSymbols(instruments),
      tradingDays: new FeedTradingDays(candles, { now: () => NOW }),
      brokerages: new FeedBrokerageDirectory({ accessToken: async () => "access-1", renewAccessToken: async () => "access-2" }, { transport }),
      transport,
      baseUrl: "https://market.test",
      now: () => NOW,
    }),
  }
}

const REQUEST = { instrumentUid: "viop-ftr-garan", range: { start: null, end: null } } as const

describe("FeedBrokerageDistributionSource", () => {
  /**
   * The failure this exists to prevent: a contract code sent to a feed that only
   * reports on cash equities, which answers with an empty reading rather than an
   * error.
   */
  test("reads the underlying stock, with the licence token", async () => {
    const { subject, requests } = build()
    await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    const akd = requests.find((request) => request.url.includes("/akd"))
    const url = new URL(akd?.url ?? "")
    expect(url.searchParams.get("code")).toBe("GARAN")
    expect(akd?.token).toBe("licence-1")
  })

  // A null range means the current session, and the session is the newest day
  // the exchange traded rather than whatever today happens to be.
  test("defaults the range to the newest trading day", async () => {
    const { subject, requests } = build()
    await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    const url = new URL(requests.find((request) => request.url.includes("/akd"))?.url ?? "")
    expect(url.searchParams.get("start")).toBe("2026-08-21")
    expect(url.searchParams.get("end")).toBe("2026-08-21")
  })

  test("asks for the range it was given", async () => {
    const { subject, requests } = build()
    await subject.loadDistribution({
      instrumentUid: "viop-ftr-garan",
      side: "BUYER",
      range: { start: "2026-08-18", end: "2026-08-21" },
    })

    const url = new URL(requests.find((request) => request.url.includes("/akd"))?.url ?? "")
    expect(url.searchParams.get("start")).toBe("2026-08-18")
    expect(url.searchParams.get("end")).toBe("2026-08-21")
  })

  // A start on its own asks for that single day.
  test("reads a single day from a start alone", async () => {
    const { subject, requests } = build()
    await subject.loadDistribution({
      instrumentUid: "viop-ftr-garan",
      side: "BUYER",
      range: { start: "2026-08-18", end: null },
    })

    const url = new URL(requests.find((request) => request.url.includes("/akd"))?.url ?? "")
    expect(url.searchParams.get("start")).toBe("2026-08-18")
    expect(url.searchParams.get("end")).toBe("2026-08-18")
  })

  /**
   * The failure this exists to prevent: the whole reading rejected, and both
   * tabs left empty, because one house happened to end the day flat.
   */
  test("accepts a house with no net position, and puts it on neither side", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })
    const sellers = await subject.loadDistribution({ ...REQUEST, side: "SELLER" })

    expect([...buyers.shares, ...sellers.shares].map((share) => share.brokerage)).not.toContain("AMK")
  })

  test("keeps the houses on the side that was asked for", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })
    const sellers = await subject.loadDistribution({ ...REQUEST, side: "SELLER" })

    expect(buyers.shares.map((share) => share.brokerage)).toEqual(["Ziraat", "Tacirler", "GCM Yatırım"])
    expect(sellers.shares.map((share) => share.brokerage)).toEqual(["ZZZ", "Oyak"])
  })

  /**
   * The direction belongs to the side, so a seller's net is reported as the
   * magnitude it is. Passing the feed's own sign through would print a table of
   * negative lots under a heading that already says "Sellers".
   */
  test("reports a net as a magnitude, ranked largest first", async () => {
    const { subject } = build()
    const sellers = await subject.loadDistribution({ ...REQUEST, side: "SELLER" })

    expect(sellers.shares.map((share) => share.netLots)).toEqual([600, 400])
  })

  /**
   * The net alone cannot say whether a house was accumulating: the same net can
   * come from one-way buying or from trading both ways all day. The gross and the
   * volume share travel with it so a reader can tell those apart.
   */
  test("reports what a house traded either way, and its share of the volume", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    expect(buyers.shares[0]).toMatchObject({ brokerage: "Ziraat", netLots: 600, grossLots: 1_400, volumeShare: 40 })
  })

  test("scales the feed's fractions into percentages", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    expect(buyers.shares[0]).toEqual({
      brokerage: "Ziraat",
      netLots: 600,
      averagePrice: 131.25,
      percentage: 60,
      grossLots: 1_400,
      volumeShare: 40,
    })
  })

  // The feed groups nothing, so the headline is computed from the ranked rows.
  test("groups the leading houses against the rest", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    // Fewer houses than the group size: all three lead, and nothing is left over.
    expect(buyers.topCount).toBe(3)
    expect(buyers.topLots).toBe(1_000)
    expect(buyers.otherLots).toBe(0)
    expect(buyers.topPercentage).toBeCloseTo(100, 5)
  })

  test("reports the reading as live while the day it covers is trading", async () => {
    const { subject } = build()
    const today = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })
    const earlier = await subject.loadDistribution({
      instrumentUid: "viop-ftr-garan",
      side: "BUYER",
      range: { start: "2026-08-20", end: "2026-08-20" },
    })

    expect(today.live).toBeTrue()
    expect(earlier.live).toBeFalse()
  })

  /**
   * The picker offers five years of sessions because the custody register goes
   * back that far, but the distribution has nothing before December 2023, so
   * offering those days here would only produce empty readings.
   */
  test("leaves out days the distribution has no data for", async () => {
    const { subject } = build([
      Date.parse("2023-11-30T07:00:00Z"),
      Date.parse("2023-12-01T07:00:00Z"),
      Date.parse("2026-08-21T07:00:00Z"),
    ])
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    expect(buyers.availableDates).toEqual(["2026-08-21", "2023-12-01"])
  })

  test("offers the trading days and the spans over them", async () => {
    const { subject } = build()
    const buyers = await subject.loadDistribution({ ...REQUEST, side: "BUYER" })

    expect(buyers.availableDates).toEqual(["2026-08-21", "2026-08-20"])
    // Only the current session fits two days of history.
    expect(buyers.presets).toEqual([{ range: { start: null, end: null }, isDefault: true }])
  })

  /**
   * Both sides arrive in one response but callers ask for them separately, so
   * the range is read once however many sides want it.
   */
  test("reads one range once for both sides", async () => {
    const { subject, requests } = build()
    await Promise.all([
      subject.loadDistribution({ ...REQUEST, side: "BUYER" }),
      subject.loadDistribution({ ...REQUEST, side: "SELLER" }),
    ])

    expect(requests.filter((request) => request.url.includes("/akd"))).toHaveLength(1)
  })

  test("reads the brokerage directory once across both sides", async () => {
    const { subject, requests } = build()
    await subject.loadDistribution({ ...REQUEST, side: "BUYER" })
    await subject.loadDistribution({ ...REQUEST, side: "SELLER" })

    expect(requests.filter((request) => request.url.endsWith("/brokerages/"))).toHaveLength(1)
  })
})
