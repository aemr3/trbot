import { z } from "zod"

export interface EquityQuoteUpdate {
  symbol: string
  lastPrice: number
  timestamp: number
  sessionStatus: string | null
}

export const EquityQuoteUpdateSchema: z.ZodType<EquityQuoteUpdate> = z.object({
  symbol: z.string(),
  lastPrice: z.number(),
  timestamp: z.number(),
  sessionStatus: z.string().nullable(),
})

export type EquityQuoteListener = (update: EquityQuoteUpdate) => void

export interface EquityQuoteStream {
  subscribe(listener: EquityQuoteListener): void
  onConnectionChange(listener: (connected: boolean) => void): void
  start(symbol: string): void
  stop(): void
}
