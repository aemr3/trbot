import { describe, expect, test } from "bun:test"
import {
  DEFAULT_FINANCIAL_METRICS,
  FINANCIAL_METRICS,
} from "@trbot/market/financials.ts"
import { FINANCIAL_METRIC_FIELDS } from "./financial-metric-fields.ts"
import { FeedRecentFinancialSource } from "./financials.ts"
import type { FeedInstrumentSource } from "./instruments.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

const EMPTY_FINANCIAL_METRICS = Object.fromEntries(
  Object.values(FINANCIAL_METRIC_FIELDS).map((field) => [field, null]),
)

const RESPONSE = {
  header: ["Hisse"],
  attributes: [],
  data: [
    {
      ...EMPTY_FINANCIAL_METRICS,
      code: "THYAO",
      published_at: "2026-08-18T15:00:00Z",
      period: "2026/6",
      kapanis: 300,
      gunluk_getiri: 1.5,
      gunluk_hacim: 2_000_000_000,
      piyasa_degeri: 410_000_000_000,
      fiili_dolasim_orani: 50,
      net_kar: 15_000_000_000,
      yillik_net_kar_degisimi: 20,
      fk: 8,
      pddd: 1.2,
      fd_favok: 6,
      ozvarlik_karliligi: 18,
      favok_marji: 14,
      ceyreklik_favok_marji: 15,
      roic: 12,
      cari_oran: 1.5,
      net_borc_favok: 1.1,
      ceyreklik_net_kar_degisimi: 8,
      yillik_favok_degisimi: 16,
      ceyreklik_favok_degisimi: 4,
      yillik_satislar_degisimi: 22,
      ceyreklik_satislar_degisimi: 5,
      hisse_basina_kar: 10.5,
      yilliklandirilmis_serbest_nakit_akisi: 30_000_000_000,
    },
    {
      ...EMPTY_FINANCIAL_METRICS,
      code: "GARAN",
      published_at: "2026-08-17T15:00:00Z",
      period: "2026/6",
      kapanis: 140,
      gunluk_getiri: null,
      piyasa_degeri: 588_000_000_000,
      net_kar: 50_000_000_000,
      yillik_net_kar_degisimi: null,
      fk: null,
      pddd: 1.8,
    },
    {
      ...EMPTY_FINANCIAL_METRICS,
      code: "BOSSA",
      published_at: "2026-08-16T15:00:00Z",
      period: "2026/6",
      kapanis: 12,
      gunluk_getiri: 0,
      piyasa_degeri: 1_000_000_000,
      net_kar: 10_000_000,
      yillik_net_kar_degisimi: 5,
      fk: 10,
      pddd: 1,
    },
  ],
}

interface ScreenerRowFixture {
  code: string
  published_at: string | null
  period: string
  [key: string]: string | number | null
}

function build(body: { data: ScreenerRowFixture[] } = RESPONSE) {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      return { status: 200, body: JSON.stringify(body) }
    },
  }
  const instruments: Pick<FeedInstrumentSource, "listByKind" | "listFutures"> = {
    listByKind: async () => [
      { symbol: "THYAO", title: "Türk Hava Yolları", kind: "equity", decimals: 2, session: null },
      { symbol: "GARAN", title: "Garanti", kind: "equity", decimals: 2, session: null },
      { symbol: "BOSSA", title: "Bossa", kind: "equity", decimals: 2, session: null },
    ],
    listFutures: async () => [
      { symbol: "F_THYAO0826", title: "THYAO 2026-08", underlying: "THYAO", contractMonth: "2026-08" },
      { symbol: "F_GARAN0826", title: "GARAN 2026-08", underlying: "GARAN", contractMonth: "2026-08" },
      { symbol: "F_XU0300826", title: "XU030 2026-08", underlying: "XU030", contractMonth: "2026-08" },
      { symbol: "F_USDTRY0826", title: "USDTRY 2026-08", underlying: "USDTRY", contractMonth: "2026-08" },
    ],
  }
  const session = { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" }
  return {
    requests,
    source: new FeedRecentFinancialSource(session, instruments, {
      transport,
      baseUrl: "https://feed.test",
    }),
  }
}

describe("FeedRecentFinancialSource", () => {
  test("returns only cash equities with a current front-month VIOP contract", async () => {
    const { source, requests } = build()

    const result = await source.listRecentFinancials()

    expect(result.universe).toBe("VIOP_EQUITIES")
    expect(result.eligibleSymbols).toEqual(["GARAN", "THYAO"])
    expect(result.financials.map((row) => row.symbol)).toEqual(["THYAO", "GARAN"])
    expect(result.metrics).toEqual([...DEFAULT_FINANCIAL_METRICS])
    expect(result.financials[0]).toMatchObject({
      symbol: "THYAO",
      publishedAt: "2026-08-18T15:00:00Z",
      period: "2026/6",
      metrics: {
        LAST_PRICE: 300,
        DAILY_VOLUME: 2_000_000_000,
        ENTERPRISE_VALUE_TO_EBITDA: 6,
        RETURN_ON_INVESTED_CAPITAL: 12,
        ANNUALIZED_FREE_CASH_FLOW: 30_000_000_000,
      },
    })
    expect(requests[0]?.token).toBe("access-1")
  })

  test("forwards a requested period and limits the returned symbol subset", async () => {
    const { source, requests } = build()

    const result = await source.listRecentFinancials({ period: "2026/6", symbols: ["garan"] })

    expect(result.financials.map((row) => row.symbol)).toEqual(["GARAN"])
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/screener/")
    expect(url.searchParams.get("period")).toBe("2026/6")
    expect(url.searchParams.get("filter")).toBe(`${[
      "published_at",
      "period",
      ...DEFAULT_FINANCIAL_METRICS.map((metric) => FINANCIAL_METRIC_FIELDS[metric]),
    ].join("||!")}||`)
  })

  test("projects every signed-in screener option when all metrics are requested", async () => {
    const { source, requests } = build()

    const result = await source.listRecentFinancials({
      symbols: ["THYAO"],
      metrics: [...FINANCIAL_METRICS],
    })

    expect(result.metrics).toEqual([...FINANCIAL_METRICS])
    expect(Object.keys(result.financials[0]!.metrics)).toHaveLength(FINANCIAL_METRICS.length)
    const filter = new URL(requests[0]!.url).searchParams.get("filter")
    expect(filter).toBe(`${[
      "published_at",
      "period",
      ...FINANCIAL_METRICS.map((metric) => FINANCIAL_METRIC_FIELDS[metric]),
    ].join("||!")}||`)
    expect(new Set(Object.values(FINANCIAL_METRIC_FIELDS)).size).toBe(FINANCIAL_METRICS.length)
  })

  test("rejects non-VIOP equities before reading the screener", async () => {
    const { source, requests } = build()

    const error = await source.listRecentFinancials({ symbols: ["BOSSA"] }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected an Error")
    expect(error.message).toContain("outside scope: BOSSA")
    expect(requests).toEqual([])
  })

  test("ignores full-universe rows that do not have a published filing", async () => {
    const unpublished = { ...RESPONSE.data[2], published_at: null }
    const { source } = build({ data: [RESPONSE.data[0], RESPONSE.data[1], unpublished] })

    const result = await source.listRecentFinancials()

    expect(result.financials.map((row) => row.symbol)).toEqual(["THYAO", "GARAN"])
  })

  test("rejects malformed upstream rows instead of returning partial financials", async () => {
    const { source } = build({ data: [{ ...RESPONSE.data[0], net_kar: "15 billion" }] })

    await expect(source.listRecentFinancials({ metrics: ["NET_INCOME"] })).rejects.toThrow(
      /did not match its contract/,
    )
  })
})
