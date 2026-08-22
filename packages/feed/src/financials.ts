import { z } from "zod"
import {
  DEFAULT_FINANCIAL_METRICS,
  FINANCIAL_PERIOD_PATTERN,
  FinancialMetricValuesSchema,
  type FinancialMetric,
  type RecentFinancial,
  type RecentFinancialRequest,
  type RecentFinancialSet,
  type RecentFinancialSource,
} from "@trbot/market/financials.ts"
import { FINANCIAL_METRIC_FIELDS } from "./financial-metric-fields.ts"
import type { FeedInstrumentSource } from "./instruments.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

const ScreenerRowSchema = z.object({
  code: z.string().min(1),
  // The endpoint returns the whole equity universe before our VİOP filter and
  // uses null for companies that do not have a published filing yet.
  published_at: z.string().min(1).nullable(),
  period: z.string().regex(new RegExp(FINANCIAL_PERIOD_PATTERN)),
}).catchall(z.number().nullable())

const ScreenerResponseSchema = z.object({ data: z.array(ScreenerRowSchema) })

type FinancialInstrumentSource = Pick<FeedInstrumentSource, "listByKind" | "listFutures">

export interface FeedRecentFinancialSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
}

/** Reads the recent-financials screener without letting non-VİOP equities escape the source. */
export class FeedRecentFinancialSource implements RecentFinancialSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    private readonly instruments: FinancialInstrumentSource,
    options: FeedRecentFinancialSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  async listRecentFinancials(request: RecentFinancialRequest = {}): Promise<RecentFinancialSet> {
    if (request.period && !new RegExp(FINANCIAL_PERIOD_PATTERN).test(request.period)) {
      throw new Error(`Invalid financial period ${request.period}; expected YYYY/M`)
    }
    const metrics = [...new Set(request.metrics ?? DEFAULT_FINANCIAL_METRICS)]
    if (metrics.length === 0) throw new Error("At least one financial metric is required")

    const eligibleSymbols = await this.listEligibleSymbols(request.signal)
    if (eligibleSymbols.length === 0) throw new Error("The current VİOP universe has no equity underlyings")

    const eligible = new Set(eligibleSymbols)
    const requested = request.symbols?.map((symbol) => symbol.trim().toUpperCase())
    const outside = [...new Set(requested?.filter((symbol) => !eligible.has(symbol)) ?? [])]
    if (outside.length > 0) {
      throw new Error(
        `Financials are restricted to current VİOP equity underlyings; outside scope: ${outside.join(", ")}`,
      )
    }
    const wanted = requested ? new Set(requested) : eligible

    const response = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/screener/", {
            period: request.period ?? "null",
            filter: `${[
              "published_at",
              "period",
              ...metrics.map((metric) => FINANCIAL_METRIC_FIELDS[metric]),
            ].join("||!")}||`,
          }),
          token,
          signal: request.signal,
        },
        ScreenerResponseSchema,
      ))

    return {
      universe: "VIOP_EQUITIES",
      eligibleSymbols,
      metrics,
      financials: response.data
        .flatMap((row) => {
          const symbol = row.code.toUpperCase()
          if (!eligible.has(symbol) || !wanted.has(symbol)) return []
          const financial = toRecentFinancial(row, metrics)
          return financial ? [financial] : []
        }),
    }
  }

  private async listEligibleSymbols(signal?: AbortSignal): Promise<string[]> {
    const [futures, equities] = await Promise.all([
      this.instruments.listFutures({ signal }),
      this.instruments.listByKind("equity", { signal }),
    ])
    const equitySymbols = new Set(equities.map((instrument) => instrument.symbol.toUpperCase()))
    return [...new Set(
      futures
        .map((future) => future.underlying.toUpperCase())
        .filter((underlying) => equitySymbols.has(underlying)),
    )].sort()
  }
}

function toRecentFinancial(
  row: z.infer<typeof ScreenerRowSchema>,
  selectedMetrics: FinancialMetric[],
): RecentFinancial | null {
  if (!row.published_at) return null
  const metrics = FinancialMetricValuesSchema.parse(Object.fromEntries(
    selectedMetrics.map((metric) => [metric, row[FINANCIAL_METRIC_FIELDS[metric]]]),
  ))
  return {
    symbol: row.code.toUpperCase(),
    publishedAt: row.published_at,
    period: row.period,
    metrics,
  }
}
