import { z } from "zod"
import type {
  ShortSaleRequest,
  ShortSaleSnapshot,
  ShortSaleSource,
} from "@trbot/market/short-sales.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

const ShortSaleResponseSchema = z.object({
  start: z.string(),
  end: z.string(),
  results: z.array(z.object({
    code: z.string().min(1),
    volume: z.number(),
    total_volume: z.number(),
    lot: z.number(),
    total_lot: z.number(),
    avg_price: z.number(),
    total_avg_price: z.number(),
  })),
})

export interface FeedShortSaleSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
}

/** Reads exchange short-sale activity and normalizes its shares to percentages. */
export class FeedShortSaleSource implements ShortSaleSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    options: FeedShortSaleSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  async listShortSales(request: ShortSaleRequest = {}): Promise<ShortSaleSnapshot> {
    if (request.start && request.end && request.end < request.start) {
      throw new Error("The short-sale end date cannot precede its start date")
    }
    const response = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/short-sell-stats/", {
            start: request.start,
            end: request.end,
          }),
          token,
          signal: request.signal,
        },
        ShortSaleResponseSchema,
      ))

    return {
      startDate: response.start.slice(0, 10),
      endDate: response.end.slice(0, 10),
      activities: response.results.map((row) => ({
        symbol: row.code.toUpperCase(),
        shortSaleLots: row.lot,
        totalLots: row.total_lot,
        shortSaleVolume: row.volume,
        totalVolume: row.total_volume,
        shortSaleAveragePrice: row.avg_price,
        marketAveragePrice: row.total_avg_price,
        shortSaleLotSharePercent: percentage(row.lot, row.total_lot),
        shortSaleVolumeSharePercent: percentage(row.volume, row.total_volume),
      })),
    }
  }
}

function percentage(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole * 100
}
