import { expect, test } from "bun:test"
import { FeedViopMarginSource } from "./viop-margin.ts"
import type { FeedFutureInstrument } from "./instruments.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

const CONTRACTS: FeedFutureInstrument[] = [
  { symbol: "F_AEFES0826", title: "AEFES 2026-08", underlying: "AEFES", contractMonth: "2026-08" },
  { symbol: "F_AKBNK0826", title: "AKBNK 2026-08", underlying: "AKBNK", contractMonth: "2026-08" },
]

function build(futureColumns = [
  "psr",
  "timestamp",
  "open_interest",
  "underlying_close",
  "leverage",
  "psr_close",
  "collateral_underlying_close",
]) {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/viop-margin-call-stats/") {
        return {
          status: 200,
          body: JSON.stringify([{
            date: "2026-08-21",
            amount: 321_458_053.83,
            change: 76_582_002.23,
            change_percent: 31.27,
            usdtry: 48.0398,
            amount_usd: 6_691_494.42,
          }]),
        }
      }
      if (url.pathname === "/" && url.searchParams.get("type") === "future") {
        const values = new Map<string, number | null>(Object.entries({
          psr: 14.1,
          timestamp: 1_787_324_997,
          open_interest: 313_096,
          underlying_close: 19.24,
          leverage: 7.09,
          psr_close: 271.99,
          collateral_underlying_close: 19.29,
        }))
        return {
          status: 200,
          body: JSON.stringify({
            updated_at: "2026-08-23T21:02:40.169478111Z",
            columns: futureColumns,
            results: {
              F_AEFES0826: futureColumns.map((column) => values.get(column) ?? null),
              F_OLD0826: futureColumns.map((column) => values.get(column) ?? null),
            },
          }),
        }
      }
      throw new Error(`unexpected URL ${request.url}`)
    },
  }
  const source = new FeedViopMarginSource(
    {
      accessToken: async () => "access-1",
      renewAccessToken: async () => "access-2",
      streamToken: async () => "stream-1",
      renewStreamToken: async () => "stream-2",
    },
    { listFutures: async () => CONTRACTS },
    { transport, accountBaseUrl: "https://account.test", marketBaseUrl: "https://market.test" },
  )
  return { requests, source }
}

test("reads VIOP margin-call history with the account token", async () => {
  const { requests, source } = build()

  await expect(source.listMarginCalls()).resolves.toEqual({
    calls: [{
      date: "2026-08-21",
      amountTry: 321_458_053.83,
      amountUsd: 6_691_494.42,
      dailyChangeTry: 76_582_002.23,
      dailyChangePercent: 31.27,
      usdTryRate: 48.0398,
    }],
  })
  expect(requests[0]?.token).toBe("access-1")
})

test("maps current front-month margin requirements by named columns", async () => {
  const { requests, source } = build()

  const snapshot = await source.listMarginRequirements()

  expect(snapshot).toEqual({
    updatedAt: "2026-08-23T21:02:40.169478111Z",
    requirements: [{
      contractSymbol: "F_AEFES0826",
      underlyingSymbol: "AEFES",
      marketTimestamp: 1_787_324_997,
      futuresPrice: 19.29,
      spotPrice: 19.24,
      priceScanRiskPercent: 14.1,
      initialCollateral: 271.99,
      leverage: 7.09,
      openInterest: 313_096,
    }],
  })
  expect(requests[0]?.token).toBe("stream-1")
  expect(requests[0]?.url).toBe("https://market.test/?type=future")
})

test("rejects a futures map that drops a required column", async () => {
  const { source } = build(["timestamp", "psr"])
  await expect(source.listMarginRequirements()).rejects.toThrow("did not match its contract")
})
