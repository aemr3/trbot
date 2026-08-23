import { z } from "zod"

export interface ViopMarginCall {
  date: string
  amountTry: number
  amountUsd: number
  dailyChangeTry: number
  dailyChangePercent: number
  usdTryRate: number
}

const ViopMarginCallSchema = z.object({
  date: z.iso.date(),
  amountTry: z.number(),
  amountUsd: z.number(),
  dailyChangeTry: z.number(),
  dailyChangePercent: z.number(),
  usdTryRate: z.number(),
})

export interface ViopMarginCallSnapshot {
  calls: ViopMarginCall[]
}

export const ViopMarginCallSnapshotSchema: z.ZodType<ViopMarginCallSnapshot> = z.object({
  calls: z.array(ViopMarginCallSchema),
})

export interface ViopMarginRequirement {
  contractSymbol: string
  underlyingSymbol: string
  marketTimestamp: number
  futuresPrice: number | null
  spotPrice: number | null
  priceScanRiskPercent: number
  initialCollateral: number | null
  leverage: number | null
  openInterest: number | null
}

const ViopMarginRequirementSchema = z.object({
  contractSymbol: z.string().min(1),
  underlyingSymbol: z.string().min(1),
  marketTimestamp: z.number(),
  futuresPrice: z.number().nullable(),
  spotPrice: z.number().nullable(),
  priceScanRiskPercent: z.number(),
  initialCollateral: z.number().nullable(),
  leverage: z.number().nullable(),
  openInterest: z.number().nullable(),
})

export interface ViopMarginRequirementSnapshot {
  updatedAt: string
  requirements: ViopMarginRequirement[]
}

export const ViopMarginRequirementSnapshotSchema: z.ZodType<ViopMarginRequirementSnapshot> = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  requirements: z.array(ViopMarginRequirementSchema),
})

export interface ViopMarginSource {
  listMarginCalls(options?: { signal?: AbortSignal }): Promise<ViopMarginCallSnapshot>
  listMarginRequirements(options?: { signal?: AbortSignal }): Promise<ViopMarginRequirementSnapshot>
}
