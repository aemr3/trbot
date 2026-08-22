import { describe, expect, test } from "bun:test"
import { FeedInstrumentSource, parseFutureCode } from "./instruments.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

const UNIVERSE = {
  data: [
    { code: "GARAN", type: "equity", title: "Garanti", format: { decimals: 2 } },
    { code: "BOSSA", type: "equity", title: "Bossa", format: { decimals: 2 } },
    { code: "XU100", type: "index", title: "BIST 100", session: "0955-1810", format: { decimals: 2 } },
    { code: "USDTRY", type: "fx", title: "Dolar", session: "24x7", format: { decimals: 4 } },
    // An unknown kind must not break the whole universe.
    { code: "WAT", type: "something-new", title: "Unknown" },
  ],
}

const COLLECTIONS = [
  { title: "XU100", data: ["GARAN", "AKBNK"] },
  { title: "XU030", data: ["GARAN"] },
  {
    title: "VİOP Aktif Vade",
    data: ["F_XU0300826", "F_GARAN0826", "F_USDTRY0926", "F_XAUTRYM0826", "BROKEN"],
  },
]

function build() {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === "/symbols/") return { status: 200, body: JSON.stringify(UNIVERSE) }
      if (path === "/mobile/symbols/collections/") return { status: 200, body: JSON.stringify(COLLECTIONS) }
      throw new Error(`unexpected path ${path}`)
    },
  }
  const session = { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" }
  return {
    requests,
    instruments: new FeedInstrumentSource(session, { transport, baseUrl: "https://feed.test" }),
  }
}

describe("parseFutureCode", () => {
  // The underlying itself contains digits, so the month has to be read from the end.
  test("splits an index contract whose underlying contains digits", () => {
    expect(parseFutureCode("F_XU0300826")).toEqual({ underlying: "XU030", contractMonth: "2026-08" })
  })

  test("splits an equity contract", () => {
    expect(parseFutureCode("F_GARAN0826")).toEqual({ underlying: "GARAN", contractMonth: "2026-08" })
  })

  test("splits a currency contract", () => {
    expect(parseFutureCode("F_USDTRY0127")).toEqual({ underlying: "USDTRY", contractMonth: "2027-01" })
  })

  test("rejects anything that is not a contract code", () => {
    expect(parseFutureCode("GARAN")).toBeNull()
    expect(parseFutureCode("F_GARAN")).toBeNull()
    // Month 13 does not exist.
    expect(parseFutureCode("F_GARAN1326")).toBeNull()
  })
})

describe("FeedInstrumentSource", () => {
  test("reads the cash universe with the account token", async () => {
    const { instruments, requests } = build()
    const listed = await instruments.listInstruments()

    expect(requests[0]?.token).toBe("access-1")
    expect(listed.map((instrument) => instrument.symbol)).toEqual(["GARAN", "BOSSA", "XU100", "USDTRY"])
  })

  test("skips instrument kinds it does not model instead of failing the read", async () => {
    const { instruments } = build()
    const listed = await instruments.listInstruments()
    expect(listed.some((instrument) => instrument.symbol === "WAT")).toBe(false)
  })

  test("filters by kind", async () => {
    const { instruments } = build()
    expect((await instruments.listByKind("equity")).map((row) => row.symbol)).toEqual(["GARAN", "BOSSA"])
    expect((await instruments.listByKind("index")).map((row) => row.symbol)).toEqual(["XU100"])
  })

  test("caches the universe, which is large and does not move intraday", async () => {
    const { instruments, requests } = build()
    await instruments.listInstruments()
    await instruments.listInstruments()
    expect(requests.filter((request) => request.url.endsWith("/symbols/"))).toHaveLength(1)
  })

  /**
   * The universe endpoint carries no futures at all, so contracts come from the
   * active-contract collection instead.
   */
  test("reads futures from the active contract collection", async () => {
    const { instruments } = build()
    const futures = await instruments.listFutures()

    expect(futures.map((contract) => contract.symbol)).toEqual([
      "F_GARAN0826",
      "F_USDTRY0926",
      "F_XAUTRYM0826",
      "F_XU0300826",
    ])
  })

  test("carries the underlying and contract month on each contract", async () => {
    const { instruments } = build()
    const futures = await instruments.listFutures()
    const contract = futures.find((entry) => entry.symbol === "F_XU0300826")

    expect(contract?.underlying).toBe("XU030")
    expect(contract?.contractMonth).toBe("2026-08")
  })

  test("drops codes it cannot parse rather than inventing a contract", async () => {
    const { instruments } = build()
    const futures = await instruments.listFutures()
    expect(futures.some((contract) => contract.symbol === "BROKEN")).toBe(false)
  })

  test("finds every contract on one underlying", async () => {
    const { instruments } = build()
    expect((await instruments.contractsFor("garan")).map((row) => row.symbol)).toEqual(["F_GARAN0826"])
  })

  test("resolves contract and underlying candles from the feed universes", async () => {
    const { instruments } = build()

    await expect(instruments.resolveCandleInstrument("GARAN", "INSTRUMENT")).resolves.toEqual({
      candleSymbol: "F_GARAN0826",
      contractSymbol: "F_GARAN0826",
      underlyingSymbol: "GARAN",
      displayName: "GARAN",
    })
    await expect(instruments.resolveCandleInstrument("F_GARAN0826", "UNDERLYING")).resolves.toEqual({
      candleSymbol: "GARAN",
      contractSymbol: "F_GARAN0826",
      underlyingSymbol: "GARAN",
      displayName: "GARAN",
    })
  })

  test("resolves the XAUTRY alias only to its futures candles", async () => {
    const { instruments } = build()

    await expect(instruments.resolveCandleInstrument("XAUTRY", "INSTRUMENT")).resolves.toEqual({
      candleSymbol: "F_XAUTRYM0826",
      contractSymbol: "F_XAUTRYM0826",
      underlyingSymbol: null,
      displayName: "XAUTRY",
    })
    await expect(instruments.resolveCandleInstrument("XAUTRY", "UNDERLYING"))
      .rejects.toThrow("no underlying cash/spot candle instrument; use target INSTRUMENT")
  })

  test("does not resolve a cash symbol without an active VIOP contract", async () => {
    const { instruments } = build()
    await expect(instruments.resolveCandleInstrument("BOSSA", "UNDERLYING"))
      .rejects.toThrow("No active VIOP contract matches BOSSA")
    await expect(instruments.resolveCandleInstrument("F_GARAN0926", "INSTRUMENT"))
      .rejects.toThrow("Only nearest-expiry contracts are available")
  })

  test("reads index constituents from the same collections", async () => {
    const { instruments } = build()
    expect(await instruments.listIndexMembers("XU100")).toEqual(["GARAN", "AKBNK"])
    expect(await instruments.listIndexMembers("NOPE")).toEqual([])
  })
})
