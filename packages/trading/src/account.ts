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

export const PORTFOLIO_RANGE_LABELS: Record<PortfolioRange, string> = {
  WEEK: "1W",
  MONTH: "1M",
  THREE_MONTH: "3M",
  YEAR_TO_DATE: "YTD",
  YEAR: "1Y",
  ALL_TIME: "All",
}

/** What the range's own profit-and-loss figure should be called. */
export const PORTFOLIO_RANGE_METRIC_LABELS: Record<PortfolioRange, string> = {
  WEEK: "Week P/L",
  MONTH: "Month P/L",
  THREE_MONTH: "3M P/L",
  YEAR_TO_DATE: "YTD P/L",
  YEAR: "Year P/L",
  ALL_TIME: "All P/L",
}

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

export interface AccountSnapshot {
  portfolio: PortfolioSummary
  performance: PortfolioPerformance
  orders: AccountOrder[]
  positions: AccountPosition[]
  updatedAt: number
}

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

export type AccountLiveUpdateListener = (update: AccountLiveUpdate) => void

export interface AccountStream {
  subscribe(listener: AccountLiveUpdateListener): void
  onConnectionChange(listener: (connected: boolean) => void): void
  setPendingOrders(orderUids: string[]): void
  start(): void
  stop(): void
}
