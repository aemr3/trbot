import { z } from "zod"

export interface QuoteUpdate {
  symbol: string
  lastPrice: number | null
  ask?: number | null
  bid?: number | null
  sessionStatus: string | null
  timestamp: number
}

export const QuoteUpdateSchema: z.ZodType<QuoteUpdate> = z.object({
  symbol: z.string(),
  lastPrice: z.number().nullable(),
  ask: z.number().nullable().optional(),
  bid: z.number().nullable().optional(),
  sessionStatus: z.string().nullable(),
  timestamp: z.number(),
})

export type QuoteUpdateListener = (update: QuoteUpdate) => void

export type ConnectionListener = (connected: boolean) => void

export interface QuoteStream {
  subscribe(listener: QuoteUpdateListener): void
  // Fires true once live price frames are flowing on a connection and false
  // when it drops — "live" means real ticks, not merely an open socket.
  onConnectionChange(listener: ConnectionListener): void
  start(symbols: string[]): void
  stop(): void
}
