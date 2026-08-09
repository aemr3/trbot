export type MarketVertical = "TR"

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

export interface ViopInstrumentSource {
  listInstruments(options?: { signal?: AbortSignal }): Promise<ViopInstrument[]>
}
