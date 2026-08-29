export interface ShortSaleActivity {
  symbol: string
  shortSaleLots: number
  totalLots: number
  shortSaleVolume: number
  totalVolume: number
  shortSaleAveragePrice: number
  marketAveragePrice: number
  shortSaleLotSharePercent: number | null
  shortSaleVolumeSharePercent: number | null
}

export interface ShortSaleSnapshot {
  startDate: string
  endDate: string
  activities: ShortSaleActivity[]
}

export interface ShortSaleRequest {
  start?: string
  end?: string
  signal?: AbortSignal
}

export interface ShortSaleSource {
  listShortSales(request?: ShortSaleRequest): Promise<ShortSaleSnapshot>
}
