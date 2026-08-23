import { z } from "zod"

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

const ShortSaleActivitySchema = z.object({
  symbol: z.string().min(1),
  shortSaleLots: z.number(),
  totalLots: z.number(),
  shortSaleVolume: z.number(),
  totalVolume: z.number(),
  shortSaleAveragePrice: z.number(),
  marketAveragePrice: z.number(),
  shortSaleLotSharePercent: z.number().nullable(),
  shortSaleVolumeSharePercent: z.number().nullable(),
})

export interface ShortSaleSnapshot {
  startDate: string
  endDate: string
  activities: ShortSaleActivity[]
}

export const ShortSaleSnapshotSchema: z.ZodType<ShortSaleSnapshot> = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  activities: z.array(ShortSaleActivitySchema),
})

export interface ShortSaleRequest {
  start?: string
  end?: string
  signal?: AbortSignal
}

export interface ShortSaleSource {
  listShortSales(request?: ShortSaleRequest): Promise<ShortSaleSnapshot>
}
