import { describe, expect, test } from "bun:test"
import { FeedTradeSource, parseTradePrint, toTrade } from "./trades.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

// One page of the tape, exactly as the feed answers it.
const TAPE = {
  next: "https://api.fintables.com/mobile/orderbook/transactions/?code=GARAN&cursor=40586676",
  previous: null,
  results: [
    { p: 129.9, s: 30.0, a: "S", bb: "OYA", sb: "AKM", i: 40613119, o: "N", t: 1_787_324_992 },
    { p: 129.9, s: 1000.0, a: "S", bb: "OYA", sb: "IYF", i: 40612862, o: "N", t: 1_787_324_991 },
    // VIOP does not disclose counterparties.
    { p: 16816.0, s: 1.0, a: "B", bb: null, sb: null, i: 8498437, o: "N", t: 1_787_342_399 },
  ],
}

const BROKERAGES = [
  { code: "OYA", title: "Oyak Yatırım", short_title: "Oyak", logo: null },
  { code: "AKM", title: "Ak Yatırım", short_title: "Ak", logo: null },
  { code: "IYF", title: "İş Yatırım", short_title: null },
]

function build() {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path.endsWith("/transactions/")) return { status: 200, body: JSON.stringify(TAPE) }
      if (path.endsWith("/brokerages/")) return { status: 200, body: JSON.stringify(BROKERAGES) }
      throw new Error(`unexpected path ${path}`)
    },
  }
  return {
    requests,
    trades: new FeedTradeSource({ accessToken: async () => "access-1", renewAccessToken: async () => "access-2" }, {
      transport,
      baseUrl: "https://feed.test",
    }),
  }
}

describe("parseTradePrint", () => {
  test("reads a print", () => {
    const print = parseTradePrint({ p: 129.9, s: 30, a: "S", bb: "OYA", sb: "AKM", i: 40613119, t: 1 })
    expect(print?.p).toBe(129.9)
    expect(print?.i).toBe(40613119)
  })

  /**
   * The socket carries new prints in this same shape. Refusing anything else is
   * what keeps a changed protocol from inventing tape rows: the tape stops
   * growing instead.
   */
  test("refuses a payload that is not a print", () => {
    expect(parseTradePrint({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })).toBeNull()
    expect(parseTradePrint({})).toBeNull()
    // A price without an id is not addressable, so it is not a print.
    expect(parseTradePrint({ p: 129.9, s: 30 })).toBeNull()
  })
})

describe("toTrade", () => {
  // `a` names the aggressor: a buy print crossed into the ask.
  test("reads the aggressor as the side", () => {
    expect(toTrade({ p: 1, s: 1, a: "B", bb: null, sb: null, i: 1, t: 1 }, new Map()).side).toBe("BUY")
    expect(toTrade({ p: 1, s: 1, a: "S", bb: null, sb: null, i: 1, t: 1 }, new Map()).side).toBe("SELL")
  })

  test("renders counterparties by name", () => {
    const trade = toTrade(
      { p: 129.9, s: 30, a: "S", bb: "OYA", sb: "AKM", i: 7, t: 1 },
      new Map([["OYA", "Oyak"], ["AKM", "Ak"]]),
    )
    expect(trade).toEqual({ id: "7", price: 129.9, lots: 30, side: "SELL", buyer: "Oyak", seller: "Ak" })
  })

  // Better a code on screen than a blank where a counterparty belongs.
  test("falls back to the raw code for an unknown brokerage", () => {
    const trade = toTrade({ p: 1, s: 1, a: "B", bb: "ZZZ", sb: null, i: 1, t: 1 }, new Map())
    expect(trade.buyer).toBe("ZZZ")
    expect(trade.seller).toBeNull()
  })
})

describe("FeedTradeSource", () => {
  test("reads the tape with the account token", async () => {
    const { trades, requests } = build()
    const tape = await trades.listTrades("GARAN")

    expect(requests[0]?.token).toBe("access-1")
    expect(new URL(requests[0]?.url ?? "").searchParams.get("code")).toBe("GARAN")
    expect(tape).toHaveLength(3)
  })

  test("names the counterparties on the way out", async () => {
    const { trades } = build()
    const tape = await trades.listTrades("GARAN")

    expect(tape[0]).toEqual({ id: "40613119", price: 129.9, lots: 30, side: "SELL", buyer: "Oyak", seller: "Ak" })
    // A brokerage with no short name falls back to its full one.
    expect(tape[1]?.seller).toBe("İş Yatırım")
  })

  test("leaves VIOP counterparties empty rather than inventing them", async () => {
    const { trades } = build()
    const tape = await trades.listTrades("GARAN")
    expect(tape[2]).toMatchObject({ id: "8498437", side: "BUY", buyer: null, seller: null })
  })

  test("reads the brokerage list once across many tapes", async () => {
    const { trades, requests } = build()
    await trades.listTrades("GARAN")
    await trades.listTrades("SOKM")

    expect(requests.filter((request) => request.url.endsWith("/brokerages/"))).toHaveLength(1)
  })
})
