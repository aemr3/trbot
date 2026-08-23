import { z } from "zod"
import type {
  BrokerMarket,
  BrokerVolumeSnapshot,
  BrokerVolumeSource,
} from "@trbot/market/broker-volume.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

const VolumeByMarketSchema = z.object({
  pay: z.number().nullable(),
  viop: z.number().nullable(),
  total: z.number().nullable(),
})

const BrokerVolumeResponseSchema = z.object({
  latest_date: z.string(),
  results: z.array(z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    latest_volume: VolumeByMarketSchema,
    current_quarter_volume_avg: VolumeByMarketSchema,
    prev_quarter_volume_avg: VolumeByMarketSchema,
    latest_volume_percentage: VolumeByMarketSchema,
  })),
})

const MARKET_KEY = {
  EQUITY: "pay",
  VIOP: "viop",
  TOTAL: "total",
} as const satisfies Record<BrokerMarket, "pay" | "viop" | "total">

export interface FeedBrokerVolumeSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
}

/** Market-wide brokerage activity, distinct from directional flow in one symbol. */
export class FeedBrokerVolumeSource implements BrokerVolumeSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    options: FeedBrokerVolumeSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  async listBrokerVolumes(
    market: BrokerMarket,
    options: { signal?: AbortSignal } = {},
  ): Promise<BrokerVolumeSnapshot> {
    const response = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/brokerages/volumes/"),
          token,
          signal: options.signal,
        },
        BrokerVolumeResponseSchema,
      ))
    const key = MARKET_KEY[market]

    return {
      market,
      latestDate: response.latest_date,
      brokers: response.results.map((row) => {
        const latest = row.latest_volume[key]
        const currentQuarter = row.current_quarter_volume_avg[key]
        const previousQuarter = row.prev_quarter_volume_avg[key]
        return {
          code: row.code,
          name: row.title,
          marketSharePercent: percentage(row.latest_volume_percentage[key]),
          latestVolume: latest,
          currentQuarterAverageVolume: currentQuarter,
          previousQuarterAverageVolume: previousQuarter,
          latestVsQuarterAveragePercent: percentChange(latest, currentQuarter),
          currentVsPreviousQuarterPercent: percentChange(currentQuarter, previousQuarter),
        }
      }),
    }
  }
}

function percentChange(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null || baseline === 0) return null
  return (current - baseline) / baseline * 100
}

function percentage(value: number | null): number | null {
  return value === null ? null : value * 100
}
