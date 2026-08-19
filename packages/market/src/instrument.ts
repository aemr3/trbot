export interface ViopInstrument {
  uid: string
  symbol: string
  displayName: string
  underlyingSymbol: string | null
  lastPrice: number | null
  changePercent: number | null
  volume: number | null
  currency: string
}

export interface ViopContractDetails {
  initialCollateral: number | null
  leverage: number | null
  contractSize: number | null
  expiryDate: string | null
  sessionHigh: number | null
  sessionLow: number | null
  settlementPrice: number | null
  previousSettlementPrice: number | null
  volume: number | null
  openInterest: number | null
}

export interface ViopInstrumentSource {
  listInstruments(options?: { signal?: AbortSignal }): Promise<ViopInstrument[]>
  loadContractDetails?(instrumentUid: string, options?: { signal?: AbortSignal }): Promise<ViopContractDetails>
}

/** Resolves either a contract symbol or its underlying alias from an active instrument list. */
export function resolveViopInstrument(instruments: ViopInstrument[], rawSymbol: string): ViopInstrument {
  const wanted = rawSymbol.trim().toUpperCase()
  const matches = instruments.filter((instrument) => [
    instrument.symbol,
    instrument.displayName,
    instrument.underlyingSymbol,
  ].some((name) => name?.toUpperCase() === wanted))
  if (matches.length === 0) throw new Error(`No active VIOP contract found for ${rawSymbol}`)
  if (matches.length > 1) {
    throw new Error(`More than one contract matched ${rawSymbol}: ${matches.map((item) => item.symbol).join(", ")}`)
  }
  return matches[0]!
}

// What one contract costs to hold: the notional it controls and the collateral
// it ties up. Both are wanted in more than one place, and the notional moves
// with every tick, so the arithmetic lives here rather than in a renderer.
export interface ContractOrderCost {
  // Last price times contract size: what a single contract is exposure to.
  notional: number | null
  // Collateral one contract requires.
  required: number | null
  currency: string
}

export function contractOrderCost(instrument: ViopInstrument, details: ViopContractDetails): ContractOrderCost {
  return {
    notional: instrument.lastPrice !== null && details.contractSize !== null
      ? instrument.lastPrice * details.contractSize
      : null,
    required: details.initialCollateral,
    currency: instrument.currency,
  }
}
