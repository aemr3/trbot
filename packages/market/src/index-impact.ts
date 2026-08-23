import { z } from "zod"

/** Exchange index codes whose constituent weights are published by the market source. */
export const INDEX_IMPACT_CODES = ["XU030", "XU100", "XTUMY"] as const
export type IndexImpactCode = (typeof INDEX_IMPACT_CODES)[number]

export interface IndexImpactLevel {
  code: string
  title: string
  lastPrice: number
  previousClose: number
  changePercent: number
  pointChange: number
}

export interface IndexContribution {
  symbol: string
  lastPrice: number | null
  previousClose: number | null
  changePercent: number | null
  volume: number | null
  weightPercent: number
  /** Estimated contribution to the selected index in index points. */
  impactPoints: number | null
  broadMarketWeightPercent: number | null
  /** Estimated contribution to the broad-market index in index points. */
  broadMarketImpactPoints: number | null
}

export interface IndexBreadth {
  advancing: number
  unchanged: number
  declining: number
  unavailable: number
}

export interface IndexImpactSnapshot {
  readAt: number
  /** The selected index's feed timestamp, when its snapshot supplies one. */
  marketTimestamp: number | null
  weightsUpdatedAt: string
  index: IndexImpactLevel
  breadth: IndexBreadth
  /** Sum of the published constituent estimates; it need not equal index.pointChange. */
  estimatedConstituentImpactPoints: number
  broadMarket: IndexImpactLevel & {
    weightsUpdatedAt: string
    impactPoints: number
  }
  contributions: IndexContribution[]
}

const IndexImpactLevelSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  lastPrice: z.number(),
  previousClose: z.number(),
  changePercent: z.number(),
  pointChange: z.number(),
})

const IndexContributionSchema = z.object({
  symbol: z.string().min(1),
  lastPrice: z.number().nullable(),
  previousClose: z.number().nullable(),
  changePercent: z.number().nullable(),
  volume: z.number().nullable(),
  weightPercent: z.number(),
  impactPoints: z.number().nullable(),
  broadMarketWeightPercent: z.number().nullable(),
  broadMarketImpactPoints: z.number().nullable(),
})

export const IndexImpactSnapshotSchema: z.ZodType<IndexImpactSnapshot> = z.object({
  readAt: z.number(),
  marketTimestamp: z.number().nullable(),
  weightsUpdatedAt: z.string(),
  index: IndexImpactLevelSchema,
  breadth: z.object({
    advancing: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    declining: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  estimatedConstituentImpactPoints: z.number(),
  broadMarket: IndexImpactLevelSchema.extend({
    weightsUpdatedAt: z.string(),
    impactPoints: z.number(),
  }),
  contributions: z.array(IndexContributionSchema),
})

export interface IndexImpactSource {
  loadIndexImpact(
    index: IndexImpactCode,
    options?: { signal?: AbortSignal },
  ): Promise<IndexImpactSnapshot>
}
