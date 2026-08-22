import { describe, expect, test } from "bun:test"
import type { CandleSeries, CandleSource } from "@trbot/market/candle.ts"
import type { ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"
import { FeedBrokerageDirectory } from "./brokerages.ts"
import { InstrumentSymbols } from "./instrument-symbols.ts"
import { FeedSettlementSource } from "./settlement.ts"
import { FeedTradingDays } from "./trading-days.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

/**
 * The register on two settled days. `TGB` stands still, `YAT` adds, `TEB`
 * sheds, `NEW` appears and `OLD` vanishes — the two that only exist on one side
 * are the case a naive difference gets wrong.
 */
const REGISTERS = new Map([
  ["2026-08-21", {
    date: "2026-08-21",
    results: [
      { custodian: "TGB", value: 8_000, percentage: 0.8 },
      { custodian: "YAT", value: 1_200, percentage: 0.12 },
      { custodian: "TEB", value: 600, percentage: 0.06 },
      { custodian: "NEW", value: 200, percentage: 0.02 },
    ],
  }],
  ["2026-08-20", {
    date: "2026-08-20",
    results: [
      { custodian: "TGB", value: 8_000, percentage: 0.78 },
      { custodian: "YAT", value: 900, percentage: 0.09 },
      { custodian: "TEB", value: 1_000, percentage: 0.1 },
      { custodian: "OLD", value: 300, percentage: 0.03 },
    ],
  }],
])

/**
 * The move over the same window, as the diff endpoint reports it — the whole
 * book, not the truncated register. `OLD` is the case that matters: it is missing
 * from the 21st's register above, and differencing the two lists by hand would
 * call that a sale of its entire holding, when the diff shows it moved 100 lots.
 * Percentages here are already scaled, unlike the register's fractions.
 */
const MOVEMENT = {
  start_date: "2026-08-20",
  end_date: "2026-08-21",
  results: [
    { custodian: "YAT", difference: 300, first_value: 900, first_percentage: 9, last_value: 1_200, last_percentage: 12, percentage_change: 3 },
    { custodian: "NEW", difference: 200, first_value: 0, first_percentage: 0, last_value: 200, last_percentage: 2, percentage_change: 2 },
    { custodian: "TEB", difference: -400, first_value: 1_000, first_percentage: 10, last_value: 600, last_percentage: 6, percentage_change: -4 },
    { custodian: "OLD", difference: -100, first_value: 300, first_percentage: 3, last_value: 200, last_percentage: 2, percentage_change: -1 },
    // A house that did not move belongs on neither table.
    { custodian: "TGB", difference: 0, first_value: 8_000, first_percentage: 80, last_value: 8_000, last_percentage: 80, percentage_change: 0 },
  ],
}

const BROKERAGES = [
  { code: "TGB", title: "Garanti Bankası", short_title: "Garanti Bank." },
  { code: "YAT", title: "Yatırım Fonları", short_title: "Yat. Fon." },
  { code: "TEB", title: "TEB Yatırım", short_title: "TEB" },
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

const SESSIONS = [Date.parse("2026-08-20T07:00:00Z"), Date.parse("2026-08-21T07:00:00Z")]
const NOW = Date.parse("2026-08-21T12:00:00Z")

function build() {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/brokerages/")) return { status: 200, body: JSON.stringify(BROKERAGES) }
      if (url.pathname.endsWith("/custodies/diff/")) {
        // The endpoint snaps each date back to a settled day and echoes what it
        // used, so a window that reaches past the register answers the same way.
        const requested = url.searchParams.get("end") ?? "2026-08-21"
        const end = requested > "2026-08-21" ? "2026-08-21" : requested
        return { status: 200, body: JSON.stringify({ ...MOVEMENT, end_date: end }) }
      }
      if (!url.pathname.endsWith("/custodies/")) throw new Error(`unexpected path ${url.pathname}`)
      // No date asks for the latest settled day; a day the feed has not settled
      // is answered with the last one it has.
      const asked = url.searchParams.get("date") ?? "2026-08-21"
      const settled = [...REGISTERS.keys()].sort().reverse().find((date) => date <= asked)
      const register = settled ? REGISTERS.get(settled) : null
      return { status: 200, body: JSON.stringify(register ?? { date: null, results: [] }) }
    },
  }

  const candles: Pick<CandleSource, "loadCandles"> = {
    async loadCandles(symbol, range, interval): Promise<CandleSeries> {
      return {
        instrumentUid: symbol,
        range,
        interval,
        candles: SESSIONS.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
        availableIntervalsByRange: {
          INTRADAY: [], WEEK: [], MONTH: [], THREE_MONTH: [], YEAR: [], FIVE_YEAR: [], ALL: [],
        },
        intervalMs: null,
        currency: "TRY",
      }
    },
  }

  const instruments: ViopInstrumentSource = { async listInstruments(): Promise<ViopInstrument[]> { return [CONTRACT] } }

  return {
    requests,
    subject: new FeedSettlementSource({
      session: { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" },
      symbols: new InstrumentSymbols(instruments),
      tradingDays: new FeedTradingDays(candles, { now: () => NOW }),
      brokerages: new FeedBrokerageDirectory({ accessToken: async () => "access-1", renewAccessToken: async () => "access-2" }, { transport }),
      transport,
      baseUrl: "https://account.test",
      now: () => NOW,
    }),
  }
}

const REQUEST = { instrumentUid: "viop-ftr-garan", range: { start: null, end: null } } as const

describe("FeedSettlementSource", () => {
  test("reads the underlying stock's register by custodian", async () => {
    const { subject, requests } = build()
    await subject.loadSettlement({ ...REQUEST, mode: "HELD" })

    const url = new URL(requests.find((request) => request.url.includes("/custodies/"))?.url ?? "")
    expect(url.searchParams.get("code")).toBe("GARAN")
    expect(url.searchParams.get("index")).toBe("custodian")
  })

  // A null range asks for the latest settled day, which the feed names itself.
  test("names no date when none was asked for", async () => {
    const { subject, requests } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "HELD" })

    const url = new URL(requests.find((request) => request.url.includes("/custodies/"))?.url ?? "")
    expect(url.searchParams.has("date")).toBeFalse()
    expect(analysis.lastUpdate).toBe("2026-08-21")
  })

  test("reports the standing position, ranked by size", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "HELD" })

    expect(analysis.holdings[0]).toEqual({
      brokerage: "Garanti Bank.",
      percentage: 80,
      percentageChange: null,
      lotChange: null,
      totalLot: 8_000,
    })
    expect(analysis.holdings.map((holding) => holding.totalLot)).toEqual([8_000, 1_200, 600, 200])
  })

  test("measures who added over the range", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "GAINED" })

    expect(analysis.holdings.map((holding) => [holding.brokerage, holding.lotChange])).toEqual([
      ["Yat. Fon.", 300],
      ["NEW", 200],
    ])
    // Share of the move rather than of the market: 300 of the 500 lots added.
    expect(analysis.holdings[0]?.percentage).toBeCloseTo(60, 5)
    // The feed's own change in share, already in percentage points.
    expect(analysis.holdings[0]?.percentageChange).toBeCloseTo(3, 5)
  })

  test("measures who shed over the range", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "LOST" })

    expect(analysis.holdings.map((holding) => [holding.brokerage, holding.lotChange])).toEqual([
      ["TEB", -400],
      ["OLD", -100],
    ])
    // The headline keeps magnitudes: the direction is the mode's to carry.
    expect(analysis.topLots).toBe(500)
  })

  /**
   * The failure this exists to prevent, and the reason the move comes from the
   * feed's difference rather than from two registers: the register is truncated,
   * so `OLD` is missing from the newer one. Differencing the lists by hand would
   * report it as having sold its whole 300 lots.
   */
  test("does not mistake a house missing from the register for a sale", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "LOST" })

    const old = analysis.holdings.find((holding) => holding.brokerage === "OLD")
    expect(old?.lotChange).toBe(-100)
    expect(old?.totalLot).toBe(200)
  })

  // A house that did not move belongs on neither table.
  test("leaves a house that stood still out of both moves", async () => {
    const { subject } = build()
    const gained = await subject.loadSettlement({ ...REQUEST, mode: "GAINED" })
    const lost = await subject.loadSettlement({ ...REQUEST, mode: "LOST" })

    expect([...gained.holdings, ...lost.holdings].map((holding) => holding.brokerage))
      .not.toContain("Garanti Bank.")
  })

  // The standing position rides along with the move, so a table of sellers can
  // say what each one still holds.
  test("reports what a house was left holding after moving", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({ ...REQUEST, mode: "GAINED" })

    expect(analysis.holdings[0]?.totalLot).toBe(1_200)
  })

  /**
   * The range's own first session counts as movement within it, so the baseline
   * is the day before `start`. Both dates go out as plain calendar days — the
   * endpoint snaps each to a settled one itself.
   */
  test("measures a named range from the day before it", async () => {
    const { subject, requests } = build()
    await subject.loadSettlement({
      instrumentUid: "viop-ftr-garan",
      mode: "GAINED",
      range: { start: "2026-08-21", end: "2026-08-21" },
    })

    const diff = requests.find((request) => request.url.includes("/custodies/diff/"))
    const params = new URL(diff?.url ?? "").searchParams
    expect(params.get("start")).toBe("2026-08-20")
    expect(params.get("end")).toBe("2026-08-21")
  })

  test("reads one movement for both sides of it", async () => {
    const { subject, requests } = build()
    await Promise.all([
      subject.loadSettlement({ ...REQUEST, mode: "GAINED" }),
      subject.loadSettlement({ ...REQUEST, mode: "LOST" }),
    ])

    expect(requests.filter((request) => request.url.includes("/custodies/diff/"))).toHaveLength(1)
  })

  /**
   * The register is published a day behind the tape, and the feed answers a day
   * it has not settled with the last one it has. Saying so is the difference
   * between a stale table and a labelled one.
   */
  test("says so when the day asked for is not settled yet", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({
      instrumentUid: "viop-ftr-garan",
      mode: "HELD",
      range: { start: "2026-08-24", end: "2026-08-24" },
    })

    expect(analysis.lastUpdate).toBe("2026-08-21")
    expect(analysis.unavailableMessage).toBe("Settlement for 24 Aug is not published yet — showing 21 Aug.")
  })

  test("stays quiet when the day asked for is the day reported", async () => {
    const { subject } = build()
    const analysis = await subject.loadSettlement({
      instrumentUid: "viop-ftr-garan",
      mode: "HELD",
      range: { start: "2026-08-20", end: "2026-08-20" },
    })

    expect(analysis.unavailableMessage).toBeNull()
  })
})
