import { z } from "zod"

export interface PortfolioSummary {
  currency: string
  totalCollateral: number | null
  availableCollateral: number | null
  dailyProfitLoss: number | null
  dailyProfitLossPercent: number | null
  periodProfitLoss: number | null
  periodProfitLossPercent: number | null
}

// How far back the portfolio's performance is read. These are the provider's
// own ranges, and its chart carries at most six points for any of them.
export const PORTFOLIO_RANGES = ["WEEK", "MONTH", "THREE_MONTH", "YEAR_TO_DATE", "YEAR", "ALL_TIME"] as const
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number]

export const PORTFOLIO_RANGE_LABELS = {
  WEEK: "1W",
  MONTH: "1M",
  THREE_MONTH: "3M",
  YEAR_TO_DATE: "YTD",
  YEAR: "1Y",
  ALL_TIME: "All",
} satisfies Record<PortfolioRange, string>

/** What the range's own profit-and-loss figure should be called. */
export const PORTFOLIO_RANGE_METRIC_LABELS = {
  WEEK: "Week P/L",
  MONTH: "Month P/L",
  THREE_MONTH: "3M P/L",
  YEAR_TO_DATE: "YTD P/L",
  YEAR: "Year P/L",
  ALL_TIME: "All P/L",
} satisfies Record<PortfolioRange, string>

export function isPortfolioRange(value: string): value is PortfolioRange {
  return PORTFOLIO_RANGES.some((range) => range === value)
}

// One bar: what the account made or lost over that slice, and what it was worth
// at the end of it.
export interface PortfolioPoint {
  // Exchange-local day, "YYYY-MM-DD".
  date: string
  profitLoss: number | null
  profitLossPercent: number | null
  totalCollateral: number | null
}

export interface PortfolioPerformance {
  range: PortfolioRange
  points: PortfolioPoint[]
  // The range's own totals, which move with the range.
  profitLoss: number | null
  profitLossPercent: number | null
}

export type AccountOrderStatus = "pending" | "completed"

export interface AccountOrder {
  uid: string
  title: string
  description: string | null
  value: string | null
  status: AccountOrderStatus
}

export interface AccountPosition {
  uid: string
  symbol: string
  displayName: string
  quantity: number
  averageCost: number | null
  currentPrice: number | null
  unrealizedProfitLoss: number | null
  currency: string
  multiplier?: number
}

export const AccountPositionSchema: z.ZodType<AccountPosition> = z.object({
  uid: z.string(),
  symbol: z.string(),
  displayName: z.string(),
  quantity: z.number(),
  averageCost: z.number().nullable(),
  currentPrice: z.number().nullable(),
  unrealizedProfitLoss: z.number().nullable(),
  currency: z.string(),
  multiplier: z.number().optional(),
})

export interface AccountSnapshot {
  portfolio: PortfolioSummary
  performance: PortfolioPerformance
  orders: AccountOrder[]
  positions: AccountPosition[]
  updatedAt: number
}

const PortfolioSummarySchema = z.object({
  currency: z.string(),
  totalCollateral: z.number().nullable(),
  availableCollateral: z.number().nullable(),
  dailyProfitLoss: z.number().nullable(),
  dailyProfitLossPercent: z.number().nullable(),
  periodProfitLoss: z.number().nullable(),
  periodProfitLossPercent: z.number().nullable(),
})

const PortfolioPointSchema = z.object({
  date: z.string(),
  profitLoss: z.number().nullable(),
  profitLossPercent: z.number().nullable(),
  totalCollateral: z.number().nullable(),
})

const PortfolioPerformanceSchema = z.object({
  range: z.enum(PORTFOLIO_RANGES),
  points: z.array(PortfolioPointSchema),
  profitLoss: z.number().nullable(),
  profitLossPercent: z.number().nullable(),
})

const AccountOrderSchema = z.object({
  uid: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  value: z.string().nullable(),
  status: z.enum(["pending", "completed"]),
})

export const AccountSnapshotSchema: z.ZodType<AccountSnapshot> = z.object({
  portfolio: PortfolioSummarySchema,
  performance: PortfolioPerformanceSchema,
  orders: z.array(AccountOrderSchema),
  positions: z.array(AccountPositionSchema),
  updatedAt: z.number(),
})

export interface AccountSource {
  // The range comes in with the read because the provider returns the summary
  // and the performance chart from one call: asking for a range costs nothing
  // beyond what the snapshot already fetches.
  loadAccount(options?: { signal?: AbortSignal; portfolioRange?: PortfolioRange }): Promise<AccountSnapshot>
}

export type AccountLiveUpdate =
  | {
      type: "position"
      uid: string
      quantity: number
      averageCost: number | null
      country: string | null
    }
  | {
      type: "collateral"
      availableCollateral: number
    }
  | {
      type: "order"
      uid: string
      status: AccountOrderStatus
      providerStatus: string
      description: string | null
    }

export const AccountLiveUpdateSchema: z.ZodType<AccountLiveUpdate> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("position"),
    uid: z.string(),
    quantity: z.number(),
    averageCost: z.number().nullable(),
    country: z.string().nullable(),
  }),
  z.object({
    type: z.literal("collateral"),
    availableCollateral: z.number(),
  }),
  z.object({
    type: z.literal("order"),
    uid: z.string(),
    status: z.enum(["pending", "completed"]),
    providerStatus: z.string(),
    description: z.string().nullable(),
  }),
])

export type AccountLiveUpdateListener = (update: AccountLiveUpdate) => void

export interface AccountStream {
  subscribe(listener: AccountLiveUpdateListener): void
  onConnectionChange(listener: (connected: boolean) => void): void
  setPendingOrders(orderUids: string[]): void
  start(): void
  stop(): void
}
