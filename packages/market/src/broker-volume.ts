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

export interface BrokerVolumeSnapshot {
  market: BrokerMarket
  latestDate: string
  brokers: BrokerVolume[]
}

export interface BrokerVolumeSource {
  listBrokerVolumes(
    market: BrokerMarket,
    options?: { signal?: AbortSignal },
  ): Promise<BrokerVolumeSnapshot>
}
