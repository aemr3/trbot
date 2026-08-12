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
