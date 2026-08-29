export interface ViopMarginCall {
  date: string
  amountTry: number
  amountUsd: number
  dailyChangeTry: number
  dailyChangePercent: number
  usdTryRate: number
}

export interface ViopMarginCallSnapshot {
  calls: ViopMarginCall[]
}

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

export interface ViopMarginRequirementSnapshot {
  updatedAt: string
  requirements: ViopMarginRequirement[]
}

export interface ViopMarginSource {
  listMarginCalls(options?: { signal?: AbortSignal }): Promise<ViopMarginCallSnapshot>
  listMarginRequirements(options?: { signal?: AbortSignal }): Promise<ViopMarginRequirementSnapshot>
}
