import { z } from "zod"

export const BROKER_MARKETS = ["EQUITY", "VIOP", "TOTAL"] as const
export type BrokerMarket = (typeof BROKER_MARKETS)[number]

export interface BrokerVolume {
  code: string
  name: string
  marketSharePercent: number | null
  latestVolume: number | null
  currentQuarterAverageVolume: number | null
  previousQuarterAverageVolume: number | null
  latestVsQuarterAveragePercent: number | null
  currentVsPreviousQuarterPercent: number | null
}

const BrokerVolumeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  marketSharePercent: z.number().nullable(),
  latestVolume: z.number().nullable(),
  currentQuarterAverageVolume: z.number().nullable(),
  previousQuarterAverageVolume: z.number().nullable(),
  latestVsQuarterAveragePercent: z.number().nullable(),
  currentVsPreviousQuarterPercent: z.number().nullable(),
})

export interface BrokerVolumeSnapshot {
  market: BrokerMarket
  latestDate: string
  brokers: BrokerVolume[]
}

export const BrokerVolumeSnapshotSchema: z.ZodType<BrokerVolumeSnapshot> = z.object({
  market: z.enum(BROKER_MARKETS),
  latestDate: z.iso.date(),
  brokers: z.array(BrokerVolumeSchema),
})

export interface BrokerVolumeSource {
  listBrokerVolumes(
    market: BrokerMarket,
    options?: { signal?: AbortSignal },
  ): Promise<BrokerVolumeSnapshot>
}
