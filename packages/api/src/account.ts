import { defineOperation } from "./graphql.ts"

export interface AccountOverviewData {
  overviewV7?: {
    accounts?: Array<{
      accountUid?: string | null
      status?: string | null
      currency?: string | null
    }> | null
  } | null
}

export interface AccountOverviewVariables {
  memberId: string
  currencyCode: "TRY"
  period: "DAY"
}

interface ViopProfitLossPoint {
  // Null on the synthetic points the provider pads short histories with.
  date?: string | null
  startDate?: string | null
  totalCollateral?: number | string | null
  interestIncome?: number | string | null
  profitLoss?: {
    value?: number | string | null
    percentage?: number | string | null
  } | null
  // True for a padding point the provider invented to fill the chart.
  virtual?: boolean | null
  realized?: boolean | null
}

export interface ViopPortfolioData {
  viopRealizedProfitLoss?: {
    totalCollateral?: number | string | null
    dailyProfitLoss?: {
      value?: number | string | null
      percentage?: number | string | null
    } | null
    profitLoss?: {
      value?: number | string | null
      percentage?: number | string | null
    } | null
    profitLossChart?: {
      maxCount?: number | string | null
      timeRange?: string | null
      dataPoints?: ViopProfitLossPoint[] | null
      emptyChartFlag?: boolean | null
    } | null
  } | null
}

export interface ViopPortfolioVariables {
  // The provider takes the member uid here, not the account uid; an account uid
  // is refused outright.
  accountId: string
  period: string
}

export interface ViopMarginData {
  accountViopMarginHealthDetail?: {
    availableCollateral?: number | string | null
  } | null
}

export interface ViopMarginVariables {
  accountId: string
}

export interface AccountPositionEntry {
  assetUid?: string | null
  symbol?: string | null
  displayName?: string | null
  quantity?: number | string | null
  averageCost?: number | string | null
  currency?: string | null
  multiplier?: number | string | null
  tradePriceV3?: {
    price?: number | string | null
    extendedPrice?: number | string | null
  } | null
}

export interface AccountPositionsData {
  viopOverviewPositions?: {
    positions?: AccountPositionEntry[] | null
  } | null
}

export interface AccountPositionsVariables {
  accountId: string
}

interface AccountOrderDetail {
  title?: string | null
  titleDescription?: {
    description?: string | null
    subDescription?: { text?: string | null } | null
  } | null
  listDetailTrailing?: {
    text?: string | null
    tagText?: string | null
  } | null
}

export interface AccountOrderEntry {
  uid?: string | null
  typeV2?: string | null
  detail?: AccountOrderDetail | null
}

export interface AccountOrdersData {
  transactionHistoryForInvestmentType?: {
    items?: AccountOrderEntry[] | null
    error?: string | null
    hasMore?: boolean | null
  } | null
}

export interface AccountOrdersVariables {
  memberId: string
  status: "PENDING" | "COMPLETED"
  page: number
  size: number
  assetVertical: "TR"
  investmentType: "FUTURES"
}

export const accountOperations = {
  overview: defineOperation<AccountOverviewData, AccountOverviewVariables>(
    "overviewV7",
    "query",
    "query overviewV7($memberId: String!, $currencyCode: CurrencyCode!, $period: ProfitLossTimeRange) { overviewV7(memberUid: $memberId, currencyCode: $currencyCode, timeRange: $period) { portfolioValue profitLosses { value percentage timeRange } accounts { accountUid brokerUid status currency buyingPower cash withdrawableCash interestConsent patternDayTrader buyingPowerWithoutCredit currencyTrailingText } systemMaintenance { anyMaintenance } availableTimeRanges hasTransaction: hasTransaction(memberUid: $memberId) } }",
  ),
  positions: defineOperation<AccountPositionsData, AccountPositionsVariables>(
    "viopOverviewPositions",
    "query",
    "query viopOverviewPositions($accountId: String!) { viopOverviewPositions(investmentType: FUTURES, assetVertical: TR, memberUid: $accountId) { positions { assetUid symbol displayName quantity multiplier averageCost country todaysAverageCost collateral tradePriceV3 { price extendedPrice } } } }",
  ),
  portfolio: defineOperation<ViopPortfolioData, ViopPortfolioVariables>(
    "viopRealizedProfitLoss",
    "query",
    "query viopRealizedProfitLoss($accountId: String!, $period: ViopProfitLossTimeRange) { viopRealizedProfitLoss(currencyCode: TRY, timeRange: $period, memberUid: $accountId) { totalCollateral dailyProfitLoss { value percentage } profitLoss { value percentage } profitLossChart { maxCount timeRange dataPoints { date startDate totalCollateral interestIncome profitLoss { value percentage } sessionInfo virtual realized } emptyChartFlag missingTimestampLabel } } }",
  ),
  margin: defineOperation<ViopMarginData, ViopMarginVariables>(
    "accountViopMarginHealthDetail",
    "query",
    "query accountViopMarginHealthDetail($accountId: String!) { accountViopMarginHealthDetail(accountUid: $accountId) { availableCollateral } }",
  ),
  orders: defineOperation<AccountOrdersData, AccountOrdersVariables>(
    "transactionHistoryForInvestmentType",
    "query",
    "query transactionHistoryForInvestmentType($memberId: String!, $status: TransactionStatus!, $page: Int!, $size: Int!, $assetVertical: AssetVertical!, $investmentType: InvestmentType!) { transactionHistoryForInvestmentType(memberUid: $memberId, status: $status, page: $page, size: $size, assetVertical: $assetVertical, investmentType: $investmentType) { __typename ...midasTransactionHistory } }  fragment midasListDetail on ListDetail { title titleSupporter { text situation } titleDescription { description subDescription { text } } listDetailTrailing: trailing { __typename ... on ListDetailTrailingText { text situation size } ... on ListDetailTrailingTag { tagText tagIconUrl tagSize tagSituation } } hasChevron hasDivider }  fragment midasTransactionHistory on TransactionHistoryPage { items { uid accountUid typeV2 detail { __typename ...midasListDetail } } error hasMore }",
  ),
} as const
