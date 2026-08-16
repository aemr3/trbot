import type { BrokerageDatePreset, BrokerageDateRange } from "./broker-calendar.ts"

// What each brokerage house was left holding once a range's trades settled.
// Where the trade-flow distribution counts what changed hands, this counts the
// inventory behind it: the standing lots, and which houses added to or shed
// them over the range.
export type SettlementMode = "HELD" | "GAINED" | "LOST"

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

export interface SettlementRequest {
  // The VIOP contract's own uid; the source resolves the underlying stock behind it.
  instrumentUid: string
  mode: SettlementMode
  range: BrokerageDateRange
  signal?: AbortSignal
}

export interface SettlementSource {
  loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis>
}
