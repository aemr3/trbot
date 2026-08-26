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
  /** Exchange print time as epoch milliseconds, or null when the feed omits it. */
  timestamp: number | null
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
  /** Whether the exchange is outside its trading hours for this symbol. */
  marketClosed: boolean
}

/** The latest assembled book this server observed, retained after its live stream stops. */
export interface DepthBookSnapshot {
  book: DepthBook
  /** When the server observed this book, as epoch milliseconds. */
  updatedAt: number
}

/** Synchronous access to already-observed depth; reading it never opens or waits on a stream. */
export interface DepthBookSnapshotSource {
  getDepthBookSnapshot(symbol: string): DepthBookSnapshot | null
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
  timestamp: z.number().nullable(),
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
})

/**
 * Which instrument's book is shown.
 *
 * Both exist: the market data feed serves an order book for a stock and for the
 * contract written on it, which the brokerage feed did not — it carried only the
 * underlying's book, so the panel had no choice to offer.
 */
export const DEPTH_TARGETS = ["UNDERLYING", "INSTRUMENT"] as const

export type DepthTarget = (typeof DEPTH_TARGETS)[number]

export function isDepthTarget(value: string): value is DepthTarget {
  return DEPTH_TARGETS.some((target) => target === value)
}

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
