export interface PortfolioSummary {
  currency: string
  totalCollateral: number | null
  availableCollateral: number | null
  dailyProfitLoss: number | null
  dailyProfitLossPercent: number | null
  periodProfitLoss: number | null
  periodProfitLossPercent: number | null
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
  orders: AccountOrder[]
  positions: AccountPosition[]
  updatedAt: number
}

export interface AccountSource {
  loadAccount(options?: { signal?: AbortSignal }): Promise<AccountSnapshot>
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
