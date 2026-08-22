import {
  BrokerageDatePresetSchema,
  BrokerageDateRangeSchema,
  type BrokerageDatePreset,
  type BrokerageDateRange,
} from "./broker-calendar.ts"
import { z } from "zod"

// Which brokerage houses accumulated or distributed a stock over a date range.
// The provider reports the two sides separately: a house can appear on both.
export type BrokerageSide = "BUYER" | "SELLER"
export const BROKERAGE_SIDES = ["BUYER", "SELLER"] as const

export interface BrokerageShare {
  brokerage: string
  netLots: number
  // Volume-weighted average price this house traded at over the range.
  averagePrice: number
  percentage: number
  /**
   * Everything the house traded over the range, both directions counted.
   *
   * A net position means something different against a gross of the same size
   * than against one ten times larger: the first is one-way accumulation, the
   * second is two-way flow that happened to end slightly long. A house can also
   * be the busiest in a name and appear on neither side, having finished flat.
   */
  grossLots: number
  /** The house's share of everything traded in the name over the range. */
  volumeShare: number
}

export interface BrokerageDistribution {
  side: BrokerageSide
  // Ranked by net lots, largest first.
  shares: BrokerageShare[]
  // How many leading houses the provider groups into its headline share.
  topCount: number
  topPercentage: number
  topLots: number
  otherLots: number
  lastUpdate: string | null
  // True while the range includes the open session, so the figures still move.
  live: boolean
  presets: BrokerageDatePreset[]
  // Every trading day the provider will report on, newest first.
  availableDates: string[]
}

const BrokerageShareSchema = z.object({
  brokerage: z.string(),
  netLots: z.number(),
  averagePrice: z.number(),
  percentage: z.number(),
  grossLots: z.number(),
  volumeShare: z.number(),
})

export const BrokerageDistributionSchema: z.ZodType<BrokerageDistribution> = z.object({
  side: z.enum(BROKERAGE_SIDES),
  shares: z.array(BrokerageShareSchema),
  topCount: z.number(),
  topPercentage: z.number(),
  topLots: z.number(),
  otherLots: z.number(),
  lastUpdate: z.string().nullable(),
  live: z.boolean(),
  presets: z.array(BrokerageDatePresetSchema),
  availableDates: z.array(z.string()),
})

export interface BrokerageDistributionRequest {
  // The VIOP contract's own uid; the source resolves the underlying stock behind it.
  instrumentUid: string
  side: BrokerageSide
  range: BrokerageDateRange
  signal?: AbortSignal
}

export const BrokerageDistributionRequestSchema = z.object({
  instrumentUid: z.string().min(1),
  side: z.enum(BROKERAGE_SIDES),
  range: BrokerageDateRangeSchema,
})

export interface BrokerageDistributionSource {
  loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution>
}
