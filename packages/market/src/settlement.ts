import {
  BrokerageDatePresetSchema,
  BrokerageDateRangeSchema,
  type BrokerageDatePreset,
  type BrokerageDateRange,
} from "./broker-calendar.ts"
import { z } from "zod"

// What each brokerage house was left holding once a range's trades settled.
// Where the trade-flow distribution counts what changed hands, this counts the
// inventory behind it: the standing lots, and which houses added to or shed
// them over the range.
export type SettlementMode = "HELD" | "GAINED" | "LOST"
export const SETTLEMENT_MODES = ["HELD", "GAINED", "LOST"] as const

export interface SettlementHolding {
  brokerage: string
  // Share of the group total: of the lots held on a HELD reading, of the move
  // itself on a GAINED or LOST one.
  percentage: number
  // The move over the range. Absent on HELD readings, which report only the
  // standing position.
  percentageChange: number | null
  lotChange: number | null
  // The standing position at the end of the range; the provider reports it on
  // HELD readings only.
  totalLot: number | null
}

export interface SettlementAnalysis {
  mode: SettlementMode
  // Ranked by size, largest first.
  holdings: SettlementHolding[]
  // How many leading houses the provider groups into its headline share.
  topCount: number
  topPercentage: number
  // Lots held on a HELD reading, lots moved on a GAINED or LOST one. Always a
  // magnitude: the direction is the mode.
  topLots: number
  otherLots: number
  lastUpdate: string | null
  // True while the range includes the open session, so the figures still move.
  live: boolean
  presets: BrokerageDatePreset[]
  // Every trading day the provider will report on, newest first.
  availableDates: string[]
  // The provider's own note when the range runs past the last settled day, as
  // the register is only published once a session has cleared.
  unavailableMessage: string | null
}

const SettlementHoldingSchema = z.object({
  brokerage: z.string(),
  percentage: z.number(),
  percentageChange: z.number().nullable(),
  lotChange: z.number().nullable(),
  totalLot: z.number().nullable(),
})

export const SettlementAnalysisSchema: z.ZodType<SettlementAnalysis> = z.object({
  mode: z.enum(SETTLEMENT_MODES),
  holdings: z.array(SettlementHoldingSchema),
  topCount: z.number(),
  topPercentage: z.number(),
  topLots: z.number(),
  otherLots: z.number(),
  lastUpdate: z.string().nullable(),
  live: z.boolean(),
  presets: z.array(BrokerageDatePresetSchema),
  availableDates: z.array(z.string()),
  unavailableMessage: z.string().nullable(),
})

export interface SettlementRequest {
  // The VIOP contract's own uid; the source resolves the underlying stock behind it.
  instrumentUid: string
  mode: SettlementMode
  range: BrokerageDateRange
  signal?: AbortSignal
}

export const SettlementRequestSchema = z.object({
  instrumentUid: z.string().min(1),
  mode: z.enum(SETTLEMENT_MODES),
  range: BrokerageDateRangeSchema,
})

export interface SettlementSource {
  loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis>
}
