import { z } from "zod"

export interface DepthLevel {
  price: number
  lots: number
  orderCount: number
}

export interface DepthTrade {
  id: string
  price: number
  lots: number
  // Which side crossed the spread: BUY means the trade printed on the ask.
  side: "BUY" | "SELL"
  buyer: string | null
  seller: string | null
}

export interface DepthBook {
  symbol: string
  // Both sides run best-price first, so `bids[0]` and `asks[0]` straddle the spread.
  bids: DepthLevel[]
  asks: DepthLevel[]
  // Total resting lots on each side of the book, behind the buy/sell ratio bar.
  buyLots: number | null
  sellLots: number | null
  trades: DepthTrade[]
  marketClosed: boolean
  maintenance: boolean
  infoMessage: string | null
}

const DepthLevelSchema = z.object({
  price: z.number(),
  lots: z.number(),
  orderCount: z.number(),
})

const DepthTradeSchema = z.object({
  id: z.string(),
  price: z.number(),
  lots: z.number(),
  side: z.enum(["BUY", "SELL"]),
  buyer: z.string().nullable(),
  seller: z.string().nullable(),
})

export const DepthBookSchema: z.ZodType<DepthBook> = z.object({
  symbol: z.string(),
  bids: z.array(DepthLevelSchema),
  asks: z.array(DepthLevelSchema),
  buyLots: z.number().nullable(),
  sellLots: z.number().nullable(),
  trades: z.array(DepthTradeSchema),
  marketClosed: z.boolean(),
  maintenance: z.boolean(),
  infoMessage: z.string().nullable(),
})

export const DEPTH_STATUSES = [
  // No symbol subscribed.
  "idle",
  // Subscribed, waiting for the opening snapshot.
  "connecting",
  // Frames are flowing.
  "live",
  // The provider has no depth book for this symbol, or the member is not
  // entitled to it. Retrying will not help, so the stream stays stopped.
  "unavailable",
] as const

export type DepthStatus = (typeof DEPTH_STATUSES)[number]

export type DepthBookListener = (book: DepthBook) => void
export type DepthStatusListener = (status: DepthStatus) => void

export interface DepthStream {
  subscribe(listener: DepthBookListener): void
  onStatusChange(listener: DepthStatusListener): void
  start(symbol: string): void
  stop(): void
}
