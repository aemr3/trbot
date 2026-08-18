export interface EquityQuoteUpdate {
  symbol: string
  lastPrice: number
  timestamp: number
  sessionStatus: string | null
}

export type EquityQuoteListener = (update: EquityQuoteUpdate) => void

export interface EquityQuoteStream {
  subscribe(listener: EquityQuoteListener): void
  onConnectionChange(listener: (connected: boolean) => void): void
  start(symbol: string): void
  stop(): void
}
