import { z } from "zod"
import type {
  ViopMarginCallSnapshot,
  ViopMarginRequirement,
  ViopMarginRequirementSnapshot,
  ViopMarginSource,
} from "@trbot/market/viop-margin.ts"
import type { FeedInstrumentSource } from "./instruments.ts"
import { MARKET_SERVER_BASE } from "./brokerage.ts"
import {
  ACCOUNT_API_BASE,
  withAccessToken,
  withStreamToken,
  type FeedSession,
} from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

const MarginCallResponseSchema = z.array(z.object({
  date: z.string(),
  amount: z.number(),
  change: z.number(),
  change_percent: z.number(),
  usdtry: z.number(),
  amount_usd: z.number(),
}))

const REQUIRED_FUTURE_COLUMNS = [
  "timestamp",
  "collateral_underlying_close",
  "underlying_close",
  "psr",
  "psr_close",
  "leverage",
  "open_interest",
] as const

const FutureMapResponseSchema = z.object({
  updated_at: z.string(),
  columns: z.array(z.string()),
  results: z.record(z.string(), z.array(z.number().nullable())),
}).superRefine((response, context) => {
  for (const column of REQUIRED_FUTURE_COLUMNS) {
    if (!response.columns.includes(column)) {
      context.addIssue({ code: "custom", message: `Missing futures column ${column}` })
    }
  }
  for (const [symbol, row] of Object.entries(response.results)) {
    if (row.length < response.columns.length) {
      context.addIssue({
        code: "custom",
        message: `Futures row ${symbol} has ${row.length} values for ${response.columns.length} columns`,
      })
    }
  }
})

type MarginInstrumentSource = Pick<FeedInstrumentSource, "listFutures">

export interface FeedViopMarginSourceOptions {
  transport?: FeedTransport
  accountBaseUrl?: string
  marketBaseUrl?: string
}

/** Market-wide VIOP stress history and current front-month collateral requirements. */
export class FeedViopMarginSource implements ViopMarginSource {
  private readonly transport: FeedTransport
  private readonly accountBaseUrl: string
  private readonly marketBaseUrl: string

  constructor(
    private readonly session: Pick<
      FeedSession,
      "accessToken" | "renewAccessToken" | "streamToken" | "renewStreamToken"
    >,
    private readonly instruments: MarginInstrumentSource,
    options: FeedViopMarginSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.accountBaseUrl = options.accountBaseUrl ?? ACCOUNT_API_BASE
    this.marketBaseUrl = options.marketBaseUrl ?? MARKET_SERVER_BASE
  }

  async listMarginCalls(options: { signal?: AbortSignal } = {}): Promise<ViopMarginCallSnapshot> {
    const rows = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.accountBaseUrl, "/viop-margin-call-stats/"),
          token,
          signal: options.signal,
        },
        MarginCallResponseSchema,
      ))
    return {
      calls: rows.map((row) => ({
        date: row.date,
        amountTry: row.amount,
        amountUsd: row.amount_usd,
        dailyChangeTry: row.change,
        dailyChangePercent: row.change_percent,
        usdTryRate: row.usdtry,
      })),
    }
  }

  async listMarginRequirements(
    options: { signal?: AbortSignal } = {},
  ): Promise<ViopMarginRequirementSnapshot> {
    const [contracts, response] = await Promise.all([
      this.instruments.listFutures({ signal: options.signal }),
      withStreamToken(this.session, (token) =>
        readJson(
          this.transport,
          {
            url: buildUrl(this.marketBaseUrl, "/", { type: "future" }),
            token,
            signal: options.signal,
          },
          FutureMapResponseSchema,
        )),
    ])
    const columns = new Map(response.columns.map((column, index) => [column, index]))
    const requirements = contracts.flatMap((contract): ViopMarginRequirement[] => {
      const row = response.results[contract.symbol]
      if (!row) return []
      return [{
        contractSymbol: contract.symbol,
        underlyingSymbol: contract.underlying,
        marketTimestamp: requiredNumber(row, columns, "timestamp"),
        futuresPrice: optionalNumber(row, columns, "collateral_underlying_close"),
        spotPrice: optionalNumber(row, columns, "underlying_close"),
        priceScanRiskPercent: requiredNumber(row, columns, "psr"),
        initialCollateral: optionalNumber(row, columns, "psr_close"),
        leverage: optionalNumber(row, columns, "leverage"),
        openInterest: optionalNumber(row, columns, "open_interest"),
      }]
    })
    return { updatedAt: response.updated_at, requirements }
  }
}

function optionalNumber(
  row: Array<number | null>,
  columns: Map<string, number>,
  column: string,
): number | null {
  const index = columns.get(column)
  return index === undefined ? null : row[index] ?? null
}

function requiredNumber(
  row: Array<number | null>,
  columns: Map<string, number>,
  column: string,
): number {
  const value = optionalNumber(row, columns, column)
  if (value === null) throw new Error(`Futures response has no numeric ${column}`)
  return value
}
