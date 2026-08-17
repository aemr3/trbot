import type { ApiClient } from "../api/index.ts"
import {
  accountOperations,
  type AccountOrderEntry,
  type AccountOverviewData,
  type AccountPositionEntry,
  type ViopMarginData,
  type ViopPortfolioData,
} from "../api/account.ts"
import type {
  AccountOrder,
  AccountOrderStatus,
  AccountPosition,
  AccountSnapshot,
  AccountSource,
  PortfolioPerformance,
  PortfolioPoint,
  PortfolioRange,
  PortfolioSummary,
} from "./account.ts"

type AccountApiClient = Pick<ApiClient, "authenticate" | "call">

const ASSET_VERTICAL = "TR"
const INVESTMENT_TYPE = "FUTURES"
const ORDER_PAGE_SIZE = 20

export class ApiAccountSource implements AccountSource {
  constructor(
    private readonly client: AccountApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  async loadAccount(
    options: { signal?: AbortSignal; portfolioRange?: PortfolioRange } = {},
  ): Promise<AccountSnapshot> {
    const range = options.portfolioRange ?? "WEEK"
    const session = await this.client.authenticate()
    const overview = await this.client.call(
      accountOperations.overview,
      { memberId: session.memberUid, currencyCode: "TRY", period: "DAY" },
      options,
    )
    const accountUid = activeAccountUid(overview)

    const [portfolio, margin, positions, pendingOrders, completedOrders] = await Promise.all([
      this.client.call(
        accountOperations.portfolio,
        { accountId: session.memberUid, period: range },
        options,
      ),
      this.client.call(
        accountOperations.margin,
        { accountId: accountUid },
        options,
      ),
      this.client.call(
        accountOperations.positions,
        { accountId: session.memberUid },
        options,
      ),
      this.client.call(
        accountOperations.orders,
        {
          memberId: session.memberUid,
          status: "PENDING",
          page: 0,
          size: ORDER_PAGE_SIZE,
          assetVertical: ASSET_VERTICAL,
          investmentType: INVESTMENT_TYPE,
        },
        options,
      ),
      this.client.call(
        accountOperations.orders,
        {
          memberId: session.memberUid,
          status: "COMPLETED",
          page: 0,
          size: ORDER_PAGE_SIZE,
          assetVertical: ASSET_VERTICAL,
          investmentType: INVESTMENT_TYPE,
        },
        options,
      ),
    ])

    return {
      portfolio: normalizePortfolio(overview, portfolio, margin, accountUid),
      performance: normalizePerformance(portfolio, range),
      positions: (positions.viopOverviewPositions?.positions ?? []).flatMap(normalizePosition),
      orders: [
        ...normalizeOrders(pendingOrders.transactionHistoryForInvestmentType?.items, "pending"),
        ...normalizeOrders(completedOrders.transactionHistoryForInvestmentType?.items, "completed"),
      ],
      updatedAt: this.now(),
    }
  }
}

function activeAccountUid(data: AccountOverviewData): string {
  const account = data.overviewV7?.accounts?.find(
    (candidate) => candidate.status === "ACTIVE" && candidate.currency === "TRY" && candidate.accountUid,
  )
  if (!account?.accountUid) throw new Error("No active TRY investment account was found")
  return account.accountUid
}

export function normalizePortfolio(
  overviewData: AccountOverviewData,
  portfolioData: ViopPortfolioData,
  marginData: ViopMarginData,
  accountUid: string,
): PortfolioSummary {
  const account = overviewData.overviewV7?.accounts?.find((candidate) => candidate.accountUid === accountUid)
  const portfolio = portfolioData.viopRealizedProfitLoss
  return {
    currency: account?.currency ?? "TRY",
    totalCollateral: finiteNumber(portfolio?.totalCollateral),
    availableCollateral: finiteNumber(marginData.accountViopMarginHealthDetail?.availableCollateral),
    dailyProfitLoss: finiteNumber(portfolio?.dailyProfitLoss?.value),
    dailyProfitLossPercent: finiteNumber(portfolio?.dailyProfitLoss?.percentage),
    periodProfitLoss: finiteNumber(portfolio?.profitLoss?.value),
    periodProfitLossPercent: finiteNumber(portfolio?.profitLoss?.percentage),
  }
}

/**
 * The range's performance bars. The provider pads a short history with
 * `virtual` points that carry invented figures against a zero collateral, so
 * those are dropped: three real bars say more than six imaginary ones.
 */
export function normalizePerformance(data: ViopPortfolioData, range: PortfolioRange): PortfolioPerformance {
  const portfolio = data.viopRealizedProfitLoss
  const points: PortfolioPoint[] = []
  for (const point of portfolio?.profitLossChart?.dataPoints ?? []) {
    if (point.virtual || !point.date) continue
    points.push({
      date: point.date,
      profitLoss: finiteNumber(point.profitLoss?.value),
      profitLossPercent: finiteNumber(point.profitLoss?.percentage),
      totalCollateral: finiteNumber(point.totalCollateral),
    })
  }
  return {
    range,
    points,
    profitLoss: finiteNumber(portfolio?.profitLoss?.value),
    profitLossPercent: finiteNumber(portfolio?.profitLoss?.percentage),
  }
}

export function normalizePosition(entry: AccountPositionEntry): AccountPosition[] {
  if (!entry.assetUid || !entry.symbol) return []
  const quantity = finiteNumber(entry.quantity)
  if (quantity === null) return []
  const averageCost = finiteNumber(entry.averageCost)
  const currentPrice = finiteNumber(entry.tradePriceV3?.extendedPrice) ?? finiteNumber(entry.tradePriceV3?.price)
  const multiplier = finiteNumber(entry.multiplier) ?? 1
  const unrealizedProfitLoss =
    averageCost === null || currentPrice === null ? null : (currentPrice - averageCost) * quantity * multiplier
  return [{
    uid: entry.assetUid,
    symbol: entry.symbol,
    displayName: entry.displayName ?? entry.symbol,
    quantity,
    averageCost,
    currentPrice,
    unrealizedProfitLoss,
    currency: entry.currency ?? "TRY",
    multiplier,
  }]
}

export function normalizeOrders(
  entries: AccountOrderEntry[] | null | undefined,
  status: AccountOrderStatus,
): AccountOrder[] {
  return (entries ?? []).flatMap((entry) => {
    if (!entry.uid) return []
    const detail = entry.detail
    const description = detail?.titleDescription?.description ?? detail?.titleDescription?.subDescription?.text ?? null
    const value = detail?.listDetailTrailing?.text ?? detail?.listDetailTrailing?.tagText ?? null
    return [{
      uid: entry.uid,
      title: detail?.title ?? entry.typeV2 ?? "Order",
      description,
      value,
      status,
    }]
  })
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
