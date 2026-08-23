import { Type } from "@earendil-works/pi-ai"
import type { BrokerMarket, BrokerVolume, BrokerVolumeSource } from "@trbot/market/broker-volume.ts"
import type { BrokerageDistributionSource } from "@trbot/market/brokerage.ts"
import type { BrokerageDateRange } from "@trbot/market/broker-calendar.ts"
import type { CandleInstrumentResolver, CandleSource } from "@trbot/market/candle.ts"
import type { DepthBook, DepthStream, DepthTarget } from "@trbot/market/depth.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import {
  DEFAULT_FINANCIAL_METRICS,
  FINANCIAL_METRICS,
  FINANCIAL_PERIOD_PATTERN,
  type FinancialMetric,
  type RecentFinancial,
  type RecentFinancialSource,
} from "@trbot/market/financials.ts"
import {
  resolveViopInstrument,
  type ViopInstrument,
  type ViopInstrumentSource,
} from "@trbot/market/instrument.ts"
import type {
  IndexContribution,
  IndexImpactCode,
  IndexImpactSource,
} from "@trbot/market/index-impact.ts"
import type { NewsSource } from "@trbot/market/news.ts"
import type { SettlementSource } from "@trbot/market/settlement.ts"
import type { ShortSaleActivity, ShortSaleSource } from "@trbot/market/short-sales.ts"
import type {
  ViopMarginCall,
  ViopMarginRequirement,
  ViopMarginSource,
} from "@trbot/market/viop-margin.ts"
import type { MemberFeatureSource } from "@trbot/member/features.ts"
import type { AccountSource } from "@trbot/trading/account.ts"
import type { ViopOrderCancellationSource, ViopOrderSource } from "@trbot/trading/order.ts"
import { isOpenStopRule, type StopRule } from "@trbot/trading/stop.ts"
import { toolText, type ChatTool } from "./tool.ts"

const STREAM_SNAPSHOT_TIMEOUT_MS = 10_000
const MAX_ARTICLE_CHARS = 30_000
const CANDLE_INTERVAL_HELP =
  "Supported intervals: MIN_1, MIN_5, MIN_15, MIN_30, HOUR_1, HOUR_4, DAY_1, WEEK_1, MONTH_1."

const SymbolParameter = Type.String({
  description: "Exact nearest-expiry VIOP contract returned by list_instruments, or its underlying symbol; never construct an expiry code",
  minLength: 1,
  maxLength: 80,
})
const InstrumentLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 }))
const InstrumentSort = Type.Union([
  Type.Literal("CHANGE_PERCENT"),
  Type.Literal("ABS_CHANGE_PERCENT"),
  Type.Literal("VOLUME"),
], { description: "Optional ranking field; omit to preserve the market source order" })
const SortDirection = Type.Union([Type.Literal("ASC"), Type.Literal("DESC")], {
  description: "Sort direction when sortBy is present; defaults to DESC",
})
const FinancialMetricParameter = Type.Union(
  FINANCIAL_METRICS.map((metric) => Type.Literal(metric)),
  { description: "One of the 97 signed-in Fintables screener metrics" },
)
const FinancialSort = Type.Union([
  Type.Literal("PUBLISHED_AT"),
  ...FINANCIAL_METRICS.map((metric) => Type.Literal(metric)),
])
const ResultLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 }))
const CandleRange = Type.Union([
  Type.Literal("INTRADAY"),
  Type.Literal("WEEK"),
  Type.Literal("MONTH"),
  Type.Literal("THREE_MONTH"),
  Type.Literal("YEAR"),
  Type.Literal("FIVE_YEAR"),
  Type.Literal("ALL"),
])
const CandleInterval = Type.Union([
  Type.Literal("MIN_1"),
  Type.Literal("MIN_5"),
  Type.Literal("MIN_15"),
  Type.Literal("MIN_30"),
  Type.Literal("HOUR_1"),
  Type.Literal("HOUR_4"),
  Type.Literal("DAY_1"),
  Type.Literal("WEEK_1"),
  Type.Literal("MONTH_1"),
], { description: CANDLE_INTERVAL_HELP })
const CandleTarget = Type.Union([
  Type.Literal("UNDERLYING"),
  Type.Literal("INSTRUMENT"),
  Type.Literal("BIST_100"),
  Type.Literal("BIST_30"),
])
const IndexImpactIndex = Type.Union([
  Type.Literal("BIST_30"),
  Type.Literal("BIST_100"),
  Type.Literal("BIST_TUM_100"),
])
const IndexImpactSort = Type.Union([
  Type.Literal("ABS_POINT_IMPACT"),
  Type.Literal("POINT_IMPACT"),
  Type.Literal("CHANGE_PERCENT"),
  Type.Literal("WEIGHT_PERCENT"),
  Type.Literal("ABS_BROAD_MARKET_IMPACT"),
])
const IndexImpactDirection = Type.Union([
  Type.Literal("ALL"),
  Type.Literal("POSITIVE"),
  Type.Literal("NEGATIVE"),
  Type.Literal("UNCHANGED"),
  Type.Literal("UNAVAILABLE"),
])
const PortfolioRange = Type.Union([
  Type.Literal("WEEK"),
  Type.Literal("MONTH"),
  Type.Literal("THREE_MONTH"),
  Type.Literal("YEAR_TO_DATE"),
  Type.Literal("YEAR"),
  Type.Literal("ALL_TIME"),
])
const IsoDate = Type.String({ description: "Exchange-local date in YYYY-MM-DD format", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
const MarketScanLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 }))

const ShortSaleSort = Type.Union([
  Type.Literal("SHORT_SALE_LOTS"),
  Type.Literal("SHORT_SALE_VOLUME"),
  Type.Literal("LOT_SHARE_PERCENT"),
  Type.Literal("VOLUME_SHARE_PERCENT"),
])
const ShortSalesParameters = Type.Object({
  start: Type.Optional(IsoDate),
  end: Type.Optional(IsoDate),
  symbol: Type.Optional(Type.String({ description: "Exact BIST equity ticker", minLength: 1, maxLength: 30 })),
  sortBy: Type.Optional(ShortSaleSort),
  sortDirection: Type.Optional(SortDirection),
  limit: MarketScanLimit,
})
const MarginCallSort = Type.Union([
  Type.Literal("DATE"),
  Type.Literal("AMOUNT_TRY"),
  Type.Literal("DAILY_CHANGE_PERCENT"),
  Type.Literal("ABS_DAILY_CHANGE_PERCENT"),
])
const MarginCallParameters = Type.Object({
  start: Type.Optional(IsoDate),
  end: Type.Optional(IsoDate),
  sortBy: Type.Optional(MarginCallSort),
  sortDirection: Type.Optional(SortDirection),
  limit: MarketScanLimit,
})
const MarginRequirementSort = Type.Union([
  Type.Literal("UNDERLYING"),
  Type.Literal("FUTURES_PRICE"),
  Type.Literal("PSR_PERCENT"),
  Type.Literal("INITIAL_COLLATERAL"),
  Type.Literal("LEVERAGE"),
  Type.Literal("OPEN_INTEREST"),
])
const MarginRequirementParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Underlying or exact front-month contract", maxLength: 80 })),
  sortBy: Type.Optional(MarginRequirementSort),
  sortDirection: Type.Optional(SortDirection),
  limit: MarketScanLimit,
})
const BrokerMarketParameter = Type.Union([
  Type.Literal("EQUITY"),
  Type.Literal("VIOP"),
  Type.Literal("TOTAL"),
])
const BrokerVolumeSort = Type.Union([
  Type.Literal("MARKET_SHARE"),
  Type.Literal("LATEST_VOLUME"),
  Type.Literal("CURRENT_QUARTER_AVERAGE"),
  Type.Literal("PREVIOUS_QUARTER_AVERAGE"),
  Type.Literal("LATEST_VS_QUARTER_AVERAGE"),
  Type.Literal("CURRENT_VS_PREVIOUS_QUARTER"),
])
const BrokerVolumeParameters = Type.Object({
  market: Type.Optional(BrokerMarketParameter),
  query: Type.Optional(Type.String({ description: "Broker code or name fragment", maxLength: 80 })),
  sortBy: Type.Optional(BrokerVolumeSort),
  sortDirection: Type.Optional(SortDirection),
  limit: MarketScanLimit,
})

const ListInstrumentsParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Symbol or name fragment to search for", maxLength: 80 })),
  sortBy: Type.Optional(InstrumentSort),
  sortDirection: Type.Optional(SortDirection),
  limit: InstrumentLimit,
})
const RecentFinancialsParameters = Type.Object({
  period: Type.Optional(Type.String({
    description: "Reporting period as YYYY/M, such as 2026/6; omit for each company's latest filing",
    pattern: FINANCIAL_PERIOD_PATTERN,
  })),
  symbols: Type.Optional(Type.Array(Type.String({
    description: "Front-month VIOP contract or its cash-equity underlying, such as F_THYAO0826 or THYAO",
    minLength: 1,
    maxLength: 80,
  }), { minItems: 1, maxItems: 100, uniqueItems: true })),
  metrics: Type.Optional(Type.Array(FinancialMetricParameter, {
    description: "Exact metrics to return; omit for the compact trading default",
    minItems: 1,
    maxItems: FINANCIAL_METRICS.length,
    uniqueItems: true,
  })),
  includeAllMetrics: Type.Optional(Type.Boolean({
    description: "Return every available metric; cannot be combined with metrics",
  })),
  sortBy: Type.Optional(FinancialSort),
  sortDirection: Type.Optional(SortDirection),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})
const SymbolOnlyParameters = Type.Object({ symbol: SymbolParameter })
const CandleParameters = Type.Object({
  symbol: Type.Optional(Type.String({
    description: "Exact nearest-expiry contract returned by list_instruments, its underlying, or an index alias such as ASELS, XU100, XU030, BIST100, or BIST30; never construct an expiry code",
    minLength: 1,
    maxLength: 80,
  })),
  range: CandleRange,
  interval: CandleInterval,
  target: Type.Optional(CandleTarget),
  limit: Type.Optional(Type.Integer({ description: "Return only this many newest candles; omit for the complete series", minimum: 1 })),
})
const IndexImpactParameters = Type.Object({
  index: IndexImpactIndex,
  direction: Type.Optional(IndexImpactDirection),
  sortBy: Type.Optional(IndexImpactSort),
  sortDirection: Type.Optional(SortDirection),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
})
const AccountParameters = Type.Object({ range: Type.Optional(PortfolioRange) })
const DepthParameters = Type.Object({
  symbol: SymbolParameter,
  target: Type.Optional(Type.Union([
    Type.Literal("UNDERLYING"),
    Type.Literal("INSTRUMENT"),
  ], {
    description: "Read the underlying cash/spot book or the VIOP contract book; inferred from the symbol when omitted",
  })),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  trades: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, default: 25 })),
})
const BrokerageParameters = Type.Object({
  symbol: SymbolParameter,
  side: Type.Union([Type.Literal("BUYER"), Type.Literal("SELLER")]),
  start: Type.Optional(IsoDate),
  end: Type.Optional(IsoDate),
  limit: ResultLimit,
})
const SettlementParameters = Type.Object({
  symbol: SymbolParameter,
  mode: Type.Union([Type.Literal("HELD"), Type.Literal("GAINED"), Type.Literal("LOST")], {
    description: "HELD ranks current custody holdings. GAINED and LOST rank lot changes over the requested date range.",
  }),
  start: Type.Optional(Type.String({
    description: "First exchange-local date in YYYY-MM-DD format. Required for GAINED and LOST; omit only for the current HELD view.",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  end: Type.Optional(Type.String({
    description: "Last exchange-local date in YYYY-MM-DD format. Omit for a single-day reading starting on start.",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  limit: ResultLimit,
})
const ListNewsParameters = Type.Object({
  symbol: Type.Optional(SymbolParameter),
  limit: ResultLimit,
})
const ArticleParameters = Type.Object({
  uid: Type.String({ description: "Article UID returned by list_news", minLength: 1, maxLength: 300 }),
})
const EmptyParameters = Type.Object({})

export interface MarketDataSources {
  instruments: ViopInstrumentSource
  financials: RecentFinancialSource
  candles: CandleSource
  news: NewsSource
  account: AccountSource
  orders: Pick<ViopOrderSource, "prepareOrder"> & Pick<ViopOrderCancellationSource, "listPendingOrders">
  brokerage: BrokerageDistributionSource
  settlement: SettlementSource
  memberFeatures: MemberFeatureSource
  openDepthStream(): DepthStream
  openEquityQuoteStream(): EquityQuoteStream
}

export interface MarketDataToolClients {
  /** Resolved per call because provider recovery replaces every source object. */
  sources(): MarketDataSources
  /** Feed-native candle access does not require a brokerage session or uid. */
  candleData: {
    instruments: CandleInstrumentResolver
    candles: CandleSource
  }
  /** Feed-native index attribution; it does not require a brokerage session. */
  indexData: IndexImpactSource
  /** Feed-native exchange activity; none of these reads require a brokerage session. */
  shortSales: ShortSaleSource
  viopMargins: ViopMarginSource
  brokerVolumes: BrokerVolumeSource
  stops: { list(): Promise<StopRule[]> }
}

/** Read-only market, portfolio, broker, and news capabilities available to every chat agent. */
export function marketDataTools(clients: MarketDataToolClients): ChatTool[] {
  return [
    listInstrumentsTool(clients),
    recentFinancialsTool(clients),
    viopQuoteTool(clients),
    contractDetailsTool(clients),
    candlesTool(clients),
    indexImpactTool(clients),
    shortSalesTool(clients),
    marginCallsTool(clients),
    marginRequirementsTool(clients),
    brokerMarketShareTool(clients),
    accountTool(clients),
    orderBookTool(clients),
    equityQuoteTool(clients),
    brokerageTool(clients),
    settlementTool(clients),
    listNewsTool(clients),
    newsArticleTool(clients),
    pendingOrdersTool(clients),
    subscriptionFeaturesTool(clients),
    stopRulesTool(clients),
  ]
}

const INDEX_CODE_BY_TARGET = {
  BIST_30: "XU030",
  BIST_100: "XU100",
  BIST_TUM_100: "XTUMY",
} as const satisfies Record<string, IndexImpactCode>

function indexImpactTool(clients: MarketDataToolClients): ChatTool<typeof IndexImpactParameters> {
  return {
    definition: {
      name: "get_index_impact",
      description: [
        "Read current BIST 30, BIST 100, or BIST TUM-100 breadth and constituent point contributions.",
        "Returns each stock's price change, index weight, estimated index-point impact, and impact on BIST TUM.",
        "The source retains every constituent; use offset and limit to page the bounded result.",
        "Published constituent estimates can differ from the headline index move after corporate actions and index adjustments, so do not force them to reconcile.",
      ].join(" "),
      parameters: IndexImpactParameters,
    },
    run: async ({ index, direction, sortBy, sortDirection, offset, limit }, options) => {
      const snapshot = await clients.indexData.loadIndexImpact(INDEX_CODE_BY_TARGET[index], {
        signal: options.signal,
      })
      const filtered = snapshot.contributions.filter((contribution) =>
        matchesIndexDirection(contribution, direction ?? "ALL"),
      )
      const sorted = sortIndexContributions(
        filtered,
        sortBy ?? "ABS_POINT_IMPACT",
        sortDirection ?? "DESC",
      )
      const start = offset ?? 0
      const returned = sorted.slice(start, start + (limit ?? 20))
      return dataOutcome(
        `Read ${snapshot.index.title} impact; returned ${returned.length} of ${filtered.length} matching constituents.`,
        {
          ...snapshot,
          contributions: returned,
          totalConstituents: snapshot.contributions.length,
          matchedConstituents: filtered.length,
          offset: start,
          returnedConstituents: returned.length,
        },
      )
    },
  }
}

type IndexImpactSortField =
  | "ABS_POINT_IMPACT"
  | "POINT_IMPACT"
  | "CHANGE_PERCENT"
  | "WEIGHT_PERCENT"
  | "ABS_BROAD_MARKET_IMPACT"

function sortIndexContributions(
  contributions: IndexContribution[],
  sortBy: IndexImpactSortField,
  direction: "ASC" | "DESC",
): IndexContribution[] {
  return [...contributions].sort((left, right) => {
    const leftValue = indexContributionSortValue(left, sortBy)
    const rightValue = indexContributionSortValue(right, sortBy)
    if (leftValue === null) return rightValue === null ? left.symbol.localeCompare(right.symbol) : 1
    if (rightValue === null) return -1
    const comparison = direction === "ASC" ? leftValue - rightValue : rightValue - leftValue
    return comparison || left.symbol.localeCompare(right.symbol)
  })
}

function indexContributionSortValue(
  contribution: IndexContribution,
  sortBy: IndexImpactSortField,
): number | null {
  switch (sortBy) {
    case "ABS_POINT_IMPACT":
      return contribution.impactPoints === null ? null : Math.abs(contribution.impactPoints)
    case "POINT_IMPACT":
      return contribution.impactPoints
    case "CHANGE_PERCENT":
      return contribution.changePercent
    case "WEIGHT_PERCENT":
      return contribution.weightPercent
    case "ABS_BROAD_MARKET_IMPACT":
      return contribution.broadMarketImpactPoints === null
        ? null
        : Math.abs(contribution.broadMarketImpactPoints)
  }
}

function matchesIndexDirection(
  contribution: IndexContribution,
  direction: "ALL" | "POSITIVE" | "NEGATIVE" | "UNCHANGED" | "UNAVAILABLE",
): boolean {
  if (direction === "ALL") return true
  if (direction === "UNAVAILABLE") return contribution.impactPoints === null
  if (contribution.impactPoints === null) return false
  if (direction === "POSITIVE") return contribution.impactPoints > 0
  if (direction === "NEGATIVE") return contribution.impactPoints < 0
  return contribution.impactPoints === 0
}

type ShortSaleSortField =
  | "SHORT_SALE_LOTS"
  | "SHORT_SALE_VOLUME"
  | "LOT_SHARE_PERCENT"
  | "VOLUME_SHARE_PERCENT"

function shortSalesTool(clients: MarketDataToolClients): ChatTool<typeof ShortSalesParameters> {
  return {
    definition: {
      name: "list_short_sales",
      description: [
        "Rank official BIST short-sale activity over a date range, optionally for one exact equity ticker.",
        "Returns short-sale lots and value alongside total turnover, average prices, and short-sale shares of both lots and value.",
        "Short-sale activity is context for positioning and pressure; it does not by itself establish a bearish view.",
      ].join(" "),
      parameters: ShortSalesParameters,
    },
    run: async ({ start, end, symbol, sortBy, sortDirection, limit }, options) => {
      assertDateOrder(start, end, "short-sale")
      const snapshot = await clients.shortSales.listShortSales({ start, end, signal: options.signal })
      const wanted = symbol?.trim().toUpperCase()
      const matching = snapshot.activities.filter((activity) => !wanted || activity.symbol === wanted)
      const returned = sortShortSales(
        matching,
        sortBy ?? "SHORT_SALE_VOLUME",
        sortDirection ?? "DESC",
      ).slice(0, limit ?? 20)
      return dataOutcome(
        `Read short sales from ${snapshot.startDate} through ${snapshot.endDate}; returned ${returned.length} of ${matching.length} matching equities.`,
        {
          ...snapshot,
          activities: returned,
          matchedEquities: matching.length,
          returnedEquities: returned.length,
        },
      )
    },
  }
}

function sortShortSales(
  activities: ShortSaleActivity[],
  sortBy: ShortSaleSortField,
  direction: "ASC" | "DESC",
): ShortSaleActivity[] {
  return [...activities].sort((left, right) =>
    compareNullable(
      shortSaleSortValue(left, sortBy),
      shortSaleSortValue(right, sortBy),
      direction,
      left.symbol.localeCompare(right.symbol),
    ))
}

function shortSaleSortValue(activity: ShortSaleActivity, sortBy: ShortSaleSortField): number | null {
  switch (sortBy) {
    case "SHORT_SALE_LOTS": return activity.shortSaleLots
    case "SHORT_SALE_VOLUME": return activity.shortSaleVolume
    case "LOT_SHARE_PERCENT": return activity.shortSaleLotSharePercent
    case "VOLUME_SHARE_PERCENT": return activity.shortSaleVolumeSharePercent
  }
}

type MarginCallSortField = "DATE" | "AMOUNT_TRY" | "DAILY_CHANGE_PERCENT" | "ABS_DAILY_CHANGE_PERCENT"

function marginCallsTool(clients: MarketDataToolClients): ChatTool<typeof MarginCallParameters> {
  return {
    definition: {
      name: "get_viop_margin_calls",
      description: [
        "Read the market-wide VIOP margin-call time series as TRY and USD amounts with daily changes.",
        "Use it as a leveraged-market stress indicator, not as the collateral requirement for one contract.",
      ].join(" "),
      parameters: MarginCallParameters,
    },
    run: async ({ start, end, sortBy, sortDirection, limit }, options) => {
      assertDateOrder(start, end, "VIOP margin-call")
      const snapshot = await clients.viopMargins.listMarginCalls({ signal: options.signal })
      const matching = snapshot.calls.filter((call) =>
        (!start || call.date >= start) && (!end || call.date <= end),
      )
      const returned = sortMarginCalls(
        matching,
        sortBy ?? "DATE",
        sortDirection ?? "DESC",
      ).slice(0, limit ?? 20)
      return dataOutcome(
        `Read ${matching.length} VIOP margin-call observations; returned ${returned.length}.`,
        {
          calls: returned,
          matchedObservations: matching.length,
          returnedObservations: returned.length,
        },
      )
    },
  }
}

function sortMarginCalls(
  calls: ViopMarginCall[],
  sortBy: MarginCallSortField,
  direction: "ASC" | "DESC",
): ViopMarginCall[] {
  return [...calls].sort((left, right) =>
    compareNullable(
      marginCallSortValue(left, sortBy),
      marginCallSortValue(right, sortBy),
      direction,
      left.date.localeCompare(right.date),
    ))
}

function marginCallSortValue(call: ViopMarginCall, sortBy: MarginCallSortField): number {
  switch (sortBy) {
    case "DATE": return Date.parse(call.date)
    case "AMOUNT_TRY": return call.amountTry
    case "DAILY_CHANGE_PERCENT": return call.dailyChangePercent
    case "ABS_DAILY_CHANGE_PERCENT": return Math.abs(call.dailyChangePercent)
  }
}

type MarginRequirementSortField =
  | "UNDERLYING"
  | "FUTURES_PRICE"
  | "PSR_PERCENT"
  | "INITIAL_COLLATERAL"
  | "LEVERAGE"
  | "OPEN_INTEREST"

function marginRequirementsTool(
  clients: MarketDataToolClients,
): ChatTool<typeof MarginRequirementParameters> {
  return {
    definition: {
      name: "list_viop_margin_requirements",
      description: [
        "Compare current front-month VIOP futures prices, spot prices, price-scan risk, initial collateral, leverage, and open interest.",
        "Use this cross-sectional scan for ranking; use get_contract_details when one brokerage contract needs order-sizing details.",
      ].join(" "),
      parameters: MarginRequirementParameters,
    },
    run: async ({ query, sortBy, sortDirection, limit }, options) => {
      const snapshot = await clients.viopMargins.listMarginRequirements({ signal: options.signal })
      const wanted = query?.trim().toUpperCase()
      const matching = snapshot.requirements.filter((requirement) => !wanted || [
        requirement.contractSymbol,
        requirement.underlyingSymbol,
      ].some((value) => value.toUpperCase().includes(wanted)))
      const field = sortBy ?? "UNDERLYING"
      const returned = sortMarginRequirements(
        matching,
        field,
        sortDirection ?? (field === "UNDERLYING" ? "ASC" : "DESC"),
      ).slice(0, limit ?? 20)
      return dataOutcome(
        `Read VIOP margin requirements; returned ${returned.length} of ${matching.length} matching contracts.`,
        {
          ...snapshot,
          requirements: returned,
          matchedContracts: matching.length,
          returnedContracts: returned.length,
        },
      )
    },
  }
}

function sortMarginRequirements(
  requirements: ViopMarginRequirement[],
  sortBy: MarginRequirementSortField,
  direction: "ASC" | "DESC",
): ViopMarginRequirement[] {
  if (sortBy === "UNDERLYING") {
    return [...requirements].sort((left, right) => {
      const comparison = left.underlyingSymbol.localeCompare(right.underlyingSymbol)
      return direction === "ASC" ? comparison : -comparison
    })
  }
  return [...requirements].sort((left, right) =>
    compareNullable(
      marginRequirementSortValue(left, sortBy),
      marginRequirementSortValue(right, sortBy),
      direction,
      left.underlyingSymbol.localeCompare(right.underlyingSymbol),
    ))
}

function marginRequirementSortValue(
  requirement: ViopMarginRequirement,
  sortBy: Exclude<MarginRequirementSortField, "UNDERLYING">,
): number | null {
  switch (sortBy) {
    case "FUTURES_PRICE": return requirement.futuresPrice
    case "PSR_PERCENT": return requirement.priceScanRiskPercent
    case "INITIAL_COLLATERAL": return requirement.initialCollateral
    case "LEVERAGE": return requirement.leverage
    case "OPEN_INTEREST": return requirement.openInterest
  }
}

type BrokerVolumeSortField =
  | "MARKET_SHARE"
  | "LATEST_VOLUME"
  | "CURRENT_QUARTER_AVERAGE"
  | "PREVIOUS_QUARTER_AVERAGE"
  | "LATEST_VS_QUARTER_AVERAGE"
  | "CURRENT_VS_PREVIOUS_QUARTER"

function brokerMarketShareTool(clients: MarketDataToolClients): ChatTool<typeof BrokerVolumeParameters> {
  return {
    definition: {
      name: "list_broker_market_share",
      description: [
        "Rank market-wide brokerage volume and market share for equities, VIOP, or both combined.",
        "Returns the latest session alongside current- and previous-quarter daily averages and their changes.",
        "This measures participation and concentration, not whether a broker was a net buyer or seller; use get_brokerage_distribution for directional flow in one equity.",
      ].join(" "),
      parameters: BrokerVolumeParameters,
    },
    run: async ({ market, query, sortBy, sortDirection, limit }, options) => {
      const selectedMarket: BrokerMarket = market ?? "VIOP"
      const snapshot = await clients.brokerVolumes.listBrokerVolumes(selectedMarket, {
        signal: options.signal,
      })
      const wanted = query?.trim().toLocaleUpperCase("tr-TR")
      const matching = snapshot.brokers.filter((broker) =>
        (broker.currentQuarterAverageVolume !== null || broker.previousQuarterAverageVolume !== null)
        && (!wanted || [broker.code, broker.name].some((value) =>
          value.toLocaleUpperCase("tr-TR").includes(wanted)
        )),
      )
      const returned = sortBrokerVolumes(
        matching,
        sortBy ?? "MARKET_SHARE",
        sortDirection ?? "DESC",
      ).slice(0, limit ?? 20)
      return dataOutcome(
        `Read ${selectedMarket} broker market share for ${snapshot.latestDate}; returned ${returned.length} of ${matching.length} active brokers.`,
        {
          ...snapshot,
          brokers: returned,
          matchedBrokers: matching.length,
          returnedBrokers: returned.length,
        },
      )
    },
  }
}

function sortBrokerVolumes(
  brokers: BrokerVolume[],
  sortBy: BrokerVolumeSortField,
  direction: "ASC" | "DESC",
): BrokerVolume[] {
  return [...brokers].sort((left, right) =>
    compareNullable(
      brokerVolumeSortValue(left, sortBy),
      brokerVolumeSortValue(right, sortBy),
      direction,
      left.name.localeCompare(right.name),
    ))
}

function brokerVolumeSortValue(broker: BrokerVolume, sortBy: BrokerVolumeSortField): number | null {
  switch (sortBy) {
    case "MARKET_SHARE": return broker.marketSharePercent
    case "LATEST_VOLUME": return broker.latestVolume
    case "CURRENT_QUARTER_AVERAGE": return broker.currentQuarterAverageVolume
    case "PREVIOUS_QUARTER_AVERAGE": return broker.previousQuarterAverageVolume
    case "LATEST_VS_QUARTER_AVERAGE": return broker.latestVsQuarterAveragePercent
    case "CURRENT_VS_PREVIOUS_QUARTER": return broker.currentVsPreviousQuarterPercent
  }
}

function compareNullable(
  left: number | null,
  right: number | null,
  direction: "ASC" | "DESC",
  tieBreaker: number,
): number {
  if (left === null) return right === null ? tieBreaker : 1
  if (right === null) return -1
  const comparison = direction === "ASC" ? left - right : right - left
  return comparison || tieBreaker
}

function assertDateOrder(start: string | undefined, end: string | undefined, label: string): void {
  if (start && end && end < start) throw new Error(`The ${label} end date cannot precede its start date`)
}

type FinancialSortField = "PUBLISHED_AT" | FinancialMetric

function recentFinancialsTool(clients: MarketDataToolClients): ChatTool<typeof RecentFinancialsParameters> {
  return {
    definition: {
      name: "list_viop_equity_financials",
      description: [
        "List recent financial results and valuation ratios only for cash equities with a current front-month VIOP contract.",
        "Accepts either exact contract codes or their underlying stock tickers.",
        "Index, currency, metal, and non-VIOP equity financials are outside this tool's scope.",
      ].join(" "),
      parameters: RecentFinancialsParameters,
    },
    run: async ({ period, symbols, metrics, includeAllMetrics, sortBy, sortDirection, limit }, options) => {
      if (includeAllMetrics && metrics) {
        throw new Error("Choose either metrics or includeAllMetrics, not both")
      }
      const selectedMetrics: FinancialMetric[] = includeAllMetrics
        ? [...FINANCIAL_METRICS]
        : [...(metrics ?? DEFAULT_FINANCIAL_METRICS)]
      if (sortBy && sortBy !== "PUBLISHED_AT" && !selectedMetrics.includes(sortBy)) {
        selectedMetrics.push(sortBy)
      }
      const sources = clients.sources()
      const requestedSymbols = symbols
        ? await resolveFinancialSymbols(sources.instruments, symbols, options.signal)
        : undefined
      const result = await sources.financials.listRecentFinancials({
        period,
        symbols: requestedSymbols,
        metrics: selectedMetrics,
        signal: options.signal,
      })
      const sorted = sortFinancials(
        result.financials,
        sortBy ?? "PUBLISHED_AT",
        sortDirection ?? "DESC",
      )
      const returned = sorted.slice(0, limit ?? (includeAllMetrics ? 10 : 20))
      return dataOutcome(
        `Found ${result.financials.length} matching VIOP equity financial${result.financials.length === 1 ? "" : "s"}; returned ${returned.length}.`,
        {
          universe: result.universe,
          eligibleSymbols: result.eligibleSymbols,
          metrics: result.metrics,
          period: period ?? null,
          matched: result.financials.length,
          financials: returned,
        },
      )
    },
  }
}

async function resolveFinancialSymbols(
  source: ViopInstrumentSource,
  symbols: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const instruments = await source.listInstruments({ signal })
  return [...new Set(symbols.map((symbol) => {
    const instrument = resolveViopInstrument(instruments, symbol)
    return instrument.underlyingSymbol ?? instrument.symbol
  }))]
}

function sortFinancials(
  financials: RecentFinancial[],
  sortBy: FinancialSortField,
  direction: "ASC" | "DESC",
): RecentFinancial[] {
  return [...financials].sort((left, right) => {
    const leftValue = financialSortValue(left, sortBy)
    const rightValue = financialSortValue(right, sortBy)
    if (leftValue === null) return rightValue === null ? left.symbol.localeCompare(right.symbol) : 1
    if (rightValue === null) return -1
    const compared = leftValue === rightValue ? left.symbol.localeCompare(right.symbol) : leftValue - rightValue
    return direction === "ASC" ? compared : -compared
  })
}

function financialSortValue(financial: RecentFinancial, sortBy: FinancialSortField): number | null {
  if (sortBy === "PUBLISHED_AT") {
    const value = Date.parse(financial.publishedAt)
    return Number.isFinite(value) ? value : null
  }
  return financial.metrics[sortBy] ?? null
}

function listInstrumentsTool(clients: MarketDataToolClients): ChatTool<typeof ListInstrumentsParameters> {
  return {
    definition: {
      name: "list_instruments",
      description: [
        "List the nearest-expiry VIOP contract for every underlying with instrument UIDs, prices, changes, and volume.",
        "This is the authoritative contract-symbol universe: out-month expiries are not exposed, so never construct or probe another expiry code.",
      ].join(" "),
      parameters: ListInstrumentsParameters,
    },
    run: async ({ query, sortBy, sortDirection, limit }, options) => {
      const instruments = await clients.sources().instruments.listInstruments({ signal: options.signal })
      const wanted = query?.trim().toUpperCase()
      const matches = instruments.filter((instrument) => !wanted || [
        instrument.symbol,
        instrument.displayName,
        instrument.underlyingSymbol,
      ].some((value) => value?.toUpperCase().includes(wanted)))
      const returned = sortInstruments(matches, sortBy, sortDirection ?? "DESC").slice(0, limit ?? 25)
      return dataOutcome(
        `Found ${matches.length} matching VIOP contract${matches.length === 1 ? "" : "s"}; returned ${returned.length}.`,
        { matched: matches.length, instruments: returned },
      )
    },
  }
}

function sortInstruments(
  instruments: ViopInstrument[],
  sortBy: "CHANGE_PERCENT" | "ABS_CHANGE_PERCENT" | "VOLUME" | undefined,
  direction: "ASC" | "DESC",
): ViopInstrument[] {
  if (!sortBy) return instruments
  return [...instruments].sort((left, right) => {
    const leftValue = instrumentSortValue(left, sortBy)
    const rightValue = instrumentSortValue(right, sortBy)
    if (leftValue === null) return rightValue === null ? 0 : 1
    if (rightValue === null) return -1
    return direction === "ASC" ? leftValue - rightValue : rightValue - leftValue
  })
}

function instrumentSortValue(
  instrument: ViopInstrument,
  sortBy: "CHANGE_PERCENT" | "ABS_CHANGE_PERCENT" | "VOLUME",
): number | null {
  if (sortBy === "VOLUME") return instrument.volume
  if (instrument.changePercent === null) return null
  return sortBy === "ABS_CHANGE_PERCENT" ? Math.abs(instrument.changePercent) : instrument.changePercent
}

function viopQuoteTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_viop_quote",
      description: [
        "Get the latest VIOP last, bid, ask, exchange limits, collateral, contract size, and current position quantity.",
        "Use an exact contract returned by list_instruments or an underlying ticker; only its nearest expiry is available.",
        "When quote sources have no last price, returns the newest VIOP contract candle close with its source and timestamp.",
      ].join(" "),
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const quote = await sources.orders.prepareOrder({
        instrumentUid: instrument.uid,
        side: "BUY",
        signal: options.signal,
      })
      let lastPrice = quote.lastPrice ?? instrument.lastPrice
      const lastPriceSource = quote.lastPrice !== null
        ? "CONTRACT_QUOTE"
        : instrument.lastPrice !== null
          ? "INSTRUMENT_LIST"
          : "CANDLE_CLOSE"
      let lastPriceTimestamp: number | null = null
      let candleInterval: string | null = null
      if (lastPrice === null) {
        const series = await sources.candles.loadCandles(instrument.uid, "WEEK", "HOUR_1", {
          signal: options.signal,
          target: "INSTRUMENT",
        })
        const candle = series.candles.at(-1)
        if (!candle) throw new Error(`No quote or candle price is available for ${instrument.symbol}`)
        lastPrice = candle.close
        lastPriceTimestamp = candle.timestamp
        candleInterval = series.interval
      }
      return dataOutcome(`Read VIOP quote for ${instrument.displayName}.`, {
        readAt: Date.now(),
        instrument,
        quote: {
          lastPrice,
          lastPriceSource,
          lastPriceTimestamp,
          candleInterval,
          bid: quote.bid,
          ask: quote.ask,
          lowerLimit: quote.lowerLimit,
          upperLimit: quote.upperLimit,
          priceScale: quote.priceScale,
          contractSize: quote.contractSize,
          initialCollateral: quote.initialCollateral,
          availableCollateral: quote.availableCollateral,
          currentPositionQuantity: quote.currentPositionQuantity,
        },
      })
    },
  }
}

function contractDetailsTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_contract_details",
      description: "Get nearest-expiry VIOP contract leverage, size, collateral, expiry, session range, settlement, volume, and open interest. Use an exact contract returned by list_instruments or its underlying ticker; do not construct an expiry code.",
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const source = clients.sources().instruments
      const instrument = resolveViopInstrument(await source.listInstruments({ signal: options.signal }), symbol)
      if (!source.loadContractDetails) throw new Error("Contract details are unavailable")
      const details = await source.loadContractDetails(instrument.uid, { signal: options.signal })
      return dataOutcome(`Read contract details for ${instrument.displayName}.`, { instrument, details })
    },
  }
}

function candlesTool(clients: MarketDataToolClients): ChatTool<typeof CandleParameters> {
  return {
    definition: {
      name: "get_candles",
      description: [
        "Read the complete OHLCV candle series for a VIOP contract, an available underlying cash/spot instrument, BIST 100, or BIST 30.",
        "For indices, pass XU100/XU030 as symbol or select BIST_100/BIST_30 without a symbol.",
        CANDLE_INTERVAL_HELP,
      ].join(" "),
      parameters: CandleParameters,
    },
    run: async ({ symbol, range, interval, target, limit }, options) => {
      const resolvedTarget = indexTarget(target, symbol) ?? target ?? "INSTRUMENT"
      const indexSymbol = resolvedTarget === "BIST_100" ? "XU100" : resolvedTarget === "BIST_30" ? "XU030" : null
      const resolved = resolvedTarget === "UNDERLYING" || resolvedTarget === "INSTRUMENT"
        ? await clients.candleData.instruments.resolveCandleInstrument(
            requireSymbol(symbol),
            resolvedTarget,
            { signal: options.signal },
          )
        : null
      const candleSymbol = indexSymbol ?? resolved?.candleSymbol
      if (!candleSymbol) throw new Error(`Unsupported candle target ${resolvedTarget}`)
      const series = await clients.candleData.candles.loadCandles(candleSymbol, range, interval, {
        signal: options.signal,
        target: resolvedTarget,
      })
      const candles = limit === undefined ? series.candles : series.candles.slice(-limit)
      const instrument = resolved
        ? {
            symbol: resolved.contractSymbol,
            displayName: resolved.displayName,
            underlyingSymbol: resolved.underlyingSymbol,
          }
        : null
      return dataOutcome(`Read ${candles.length} ${interval} candles for ${indexSymbol ?? resolved?.displayName}.`, {
        instrument,
        symbol: indexSymbol ?? resolved?.contractSymbol,
        candleSymbol,
        target: resolvedTarget,
        range: series.range,
        interval: series.interval,
        intervalMs: series.intervalMs,
        currency: series.currency,
        availableIntervalsByRange: series.availableIntervalsByRange,
        totalCandles: series.candles.length,
        candles,
      })
    },
  }
}

function requireSymbol(symbol: string | undefined): string {
  if (!symbol?.trim()) throw new Error("A VIOP contract or underlying symbol is required for these candles")
  return symbol
}

function requireEquityUnderlying(instrument: ViopInstrument): string {
  const availability = instrument.marketData
  if (availability) {
    if (availability.underlyingKind !== "equity" || !availability.underlyingSymbol) {
      throw new Error(`${instrument.symbol} has no cash-equity underlying in the market-data feed`)
    }
    return availability.underlyingSymbol
  }
  if (!instrument.underlyingSymbol) throw new Error(`${instrument.symbol} has no underlying equity symbol`)
  return instrument.underlyingSymbol
}

function requireBrokerAnalytics(instrument: ViopInstrument): void {
  if (instrument.marketData?.brokerAnalytics === false) {
    throw new Error(`${instrument.symbol} has no cash-equity underlying for broker analytics`)
  }
}

function depthUnderlyingSymbol(instrument: ViopInstrument): string | null {
  return instrument.marketData
    ? instrument.marketData.underlyingSymbol
    : instrument.underlyingSymbol
}

function depthSymbol(instrument: ViopInstrument, target: DepthTarget): string {
  if (target === "INSTRUMENT") return instrument.symbol
  const underlyingSymbol = depthUnderlyingSymbol(instrument)
  if (!underlyingSymbol) {
    throw new Error(`${instrument.symbol} has no underlying cash/spot depth instrument; use target INSTRUMENT`)
  }
  return underlyingSymbol
}

function indexTarget(
  target: "UNDERLYING" | "INSTRUMENT" | "BIST_100" | "BIST_30" | undefined,
  symbol: string | undefined,
): "BIST_100" | "BIST_30" | null {
  if (target === "BIST_100" || target === "BIST_30") return target
  const alias = symbol?.replaceAll(/[^A-Z0-9]/gi, "").toUpperCase()
  if (alias === "XU100" || alias === "BIST100") return "BIST_100"
  if (alias === "XU030" || alias === "XU30" || alias === "BIST30") return "BIST_30"
  return null
}

function accountTool(clients: MarketDataToolClients): ChatTool<typeof AccountParameters> {
  return {
    definition: {
      name: "get_account",
      description: "Read portfolio collateral, P/L, performance, positions, and account orders without changing anything.",
      parameters: AccountParameters,
    },
    run: async ({ range }, options) => {
      const snapshot = await clients.sources().account.loadAccount({
        signal: options.signal,
        portfolioRange: range,
      })
      return dataOutcome(`Read account with ${snapshot.positions.length} open position${snapshot.positions.length === 1 ? "" : "s"}.`, snapshot)
    },
  }
}

function orderBookTool(clients: MarketDataToolClients): ChatTool<typeof DepthParameters> {
  return {
    definition: {
      name: "get_order_book",
      description: [
        "Take a live order-book snapshot for a VIOP contract or its available underlying cash/spot instrument,",
        "with bid/ask levels, total lots, and recent trades. Use target INSTRUMENT for the futures book or",
        "UNDERLYING for the underlying book. When target is omitted, a contract symbol selects INSTRUMENT;",
        "an underlying alias selects UNDERLYING unless that contract has no underlying market-data instrument.",
      ].join(" "),
      parameters: DepthParameters,
    },
    run: async ({ symbol, target, levels, trades }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const underlyingSymbol = depthUnderlyingSymbol(instrument)
      const resolvedTarget: DepthTarget = target
        ?? (symbol.trim().toUpperCase().startsWith("F_") || !underlyingSymbol ? "INSTRUMENT" : "UNDERLYING")
      const requestedSymbol = depthSymbol(instrument, resolvedTarget)
      const book = await readDepthSnapshot(sources.openDepthStream(), requestedSymbol, options.signal)
      const normalized = {
        ...book,
        symbol: requestedSymbol,
        instrumentSymbol: instrument.symbol,
        underlyingSymbol,
        target: resolvedTarget,
        bids: book.bids.slice(0, levels ?? 10),
        asks: book.asks.slice(0, levels ?? 10),
        trades: book.trades.slice(0, trades ?? 25),
      }
      const targetName = resolvedTarget === "INSTRUMENT" ? "VIOP contract" : "underlying"
      return dataOutcome(`Read ${targetName} order book for ${requestedSymbol}.`, normalized)
    },
  }
}

function equityQuoteTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_equity_quote",
      description: [
        "Get the latest price for the BIST equity underlying a VIOP contract.",
        "Uses a live trade tick when available and otherwise returns the newest underlying-equity candle close,",
        "clearly labeled with its source and timestamp.",
      ].join(" "),
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const underlyingSymbol = requireEquityUnderlying(instrument)
      try {
        const quote = await readEquityQuote(
          sources.openEquityQuoteStream(),
          underlyingSymbol,
          options.signal,
        )
        return dataOutcome(`Read live equity quote for ${quote.symbol}.`, { ...quote, source: "LIVE_TICK" })
      } catch (error) {
        if (options.signal?.aborted) throw error
        const series = await sources.candles.loadCandles(instrument.uid, "WEEK", "MIN_5", {
          signal: options.signal,
          target: "UNDERLYING",
        })
        const candle = series.candles.at(-1)
        if (!candle) throw new Error(`No live quote or candle price is available for ${underlyingSymbol}`)
        const quote = {
          symbol: underlyingSymbol,
          lastPrice: candle.close,
          timestamp: candle.timestamp,
          sessionStatus: null,
          source: "CANDLE_CLOSE",
          candleRange: series.range,
          candleInterval: series.interval,
        }
        return dataOutcome(
          `Live quote unavailable; read the latest ${series.interval} candle close for ${underlyingSymbol}.`,
          quote,
        )
      }
    },
  }
}

function brokerageTool(clients: MarketDataToolClients): ChatTool<typeof BrokerageParameters> {
  return {
    definition: {
      name: "get_brokerage_distribution",
      description: [
        "Rank brokerage houses accumulating or distributing the underlying equity over a date range.",
        "netLots is a magnitude on the side asked for — bought on BUYER, sold on SELLER — with the",
        "averagePrice behind it, grossLots for everything the house traded in either direction, and",
        "volumeShare for its share of the name's volume.",
        "Read the net against the gross: a net that is most of a house's gross means it traded one way,",
        "in the direction of the side asked for, while the same net on a far larger gross means it traded",
        "both ways and merely finished on this side.",
        "A house that finished flat appears on neither side however much it traded.",
      ].join(" "),
      parameters: BrokerageParameters,
    },
    run: async ({ symbol, side, start, end, limit }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      requireBrokerAnalytics(instrument)
      const range = dateRange(start, end)
      const distribution = await sources.brokerage.loadDistribution({
        instrumentUid: instrument.uid,
        side,
        range,
        signal: options.signal,
      })
      return dataOutcome(`Read ${side.toLowerCase()} brokerage distribution for ${instrument.displayName}.`, {
        instrument,
        range,
        ...distribution,
        shares: distribution.shares.slice(0, limit ?? 20),
        totalShares: distribution.shares.length,
      })
    },
  }
}

function settlementTool(clients: MarketDataToolClients): ChatTool<typeof SettlementParameters> {
  return {
    definition: {
      name: "get_settlement",
      description: [
        "Read brokerage custody holdings or lot changes for the underlying cash equity.",
        "HELD may omit dates and returns availableDates.",
        "GAINED and LOST require start; set end for a multi-day range or omit end for that single day.",
        "If valid settlement dates are unknown, call HELD first and choose from its availableDates.",
      ].join(" "),
      parameters: SettlementParameters,
    },
    run: async ({ symbol, mode, start, end, limit }, options) => {
      if (mode !== "HELD" && !start) {
        throw new Error(
          `get_settlement mode ${mode} requires start in YYYY-MM-DD format. `
          + "Call get_settlement with mode HELD first if you need its availableDates.",
        )
      }
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      requireBrokerAnalytics(instrument)
      const range = dateRange(start, end)
      const settlement = await sources.settlement.loadSettlement({
        instrumentUid: instrument.uid,
        mode,
        range,
        signal: options.signal,
      })
      return dataOutcome(`Read ${mode.toLowerCase()} settlement for ${instrument.displayName}.`, {
        instrument,
        range,
        ...settlement,
        holdings: settlement.holdings.slice(0, limit ?? 20),
        totalHoldings: settlement.holdings.length,
      })
    },
  }
}

function listNewsTool(clients: MarketDataToolClients): ChatTool<typeof ListNewsParameters> {
  return {
    definition: {
      name: "list_news",
      description: "List recent general market news or news for the equity underlying a VIOP contract. Use get_news_article for the body.",
      parameters: ListNewsParameters,
    },
    run: async ({ symbol, limit }, options) => {
      const sources = clients.sources()
      const instrument = symbol
        ? resolveViopInstrument(await sources.instruments.listInstruments({ signal: options.signal }), symbol)
        : null
      const articles = await sources.news.listNews({ instrumentUid: instrument?.uid, signal: options.signal })
      const returned = articles.slice(0, limit ?? 20).map(({ body: _body, ...article }) => article)
      return dataOutcome(`Found ${articles.length} news article${articles.length === 1 ? "" : "s"}; returned ${returned.length}.`, {
        instrument,
        totalArticles: articles.length,
        articles: returned,
      })
    },
  }
}

function newsArticleTool(clients: MarketDataToolClients): ChatTool<typeof ArticleParameters> {
  return {
    definition: {
      name: "get_news_article",
      description: "Read the full body and attachments of a news article returned by list_news.",
      parameters: ArticleParameters,
    },
    run: async ({ uid }, options) => {
      const article = await clients.sources().news.getArticle(uid, { signal: options.signal })
      if (!article) throw new Error(`No news article found with UID ${uid}`)
      const truncated = article.body.length > MAX_ARTICLE_CHARS
      const normalized = {
        ...article,
        body: article.body.slice(0, MAX_ARTICLE_CHARS),
        bodyTruncated: truncated,
      }
      return dataOutcome(`Read news article: ${article.headline}.`, normalized)
    },
  }
}

function pendingOrdersTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "list_pending_orders",
      description: "List pending VIOP orders without modifying or cancelling them.",
      parameters: EmptyParameters,
    },
    run: async (_args, options) => {
      const orders = await clients.sources().orders.listPendingOrders({ signal: options.signal })
      return dataOutcome(`Found ${orders.length} pending order${orders.length === 1 ? "" : "s"}.`, { orders })
    },
  }
}

function subscriptionFeaturesTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "get_data_entitlements",
      description: "List the signed-in account's enabled data entitlements, such as market depth, brokerage distribution, and settlement access.",
      parameters: EmptyParameters,
    },
    run: async (_args, options) => {
      const features = await clients.sources().memberFeatures.loadFeatures({ signal: options.signal })
      return dataOutcome("Read data entitlements.", { enabled: features.list() })
    },
  }
}

function stopRulesTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "list_stop_rules",
      description: "List open protective VIOP stop and target rules, including their levels, state, and position ownership.",
      parameters: EmptyParameters,
    },
    run: async () => {
      const rules = (await clients.stops.list()).filter(isOpenStopRule)
      return dataOutcome(`Found ${rules.length} stop or target rule${rules.length === 1 ? "" : "s"}.`, { rules })
    },
  }
}

function dataOutcome<T>(summary: string, data: T) {
  return {
    blocks: [toolText(summary)],
    modelBlocks: [toolText(JSON.stringify(data))],
    details: data,
    isError: false,
  }
}

function dateRange(start?: string, end?: string): BrokerageDateRange {
  if (end && !start) throw new Error("A brokerage range cannot have an end date without a start date")
  if (start && end && end < start) throw new Error("The brokerage range end date cannot precede its start date")
  return { start: start ?? null, end: end ?? null }
}

function readDepthSnapshot(stream: DepthStream, symbol: string, signal?: AbortSignal): Promise<DepthBook> {
  return streamSnapshot<DepthBook>({
    signal,
    start: () => stream.start(symbol),
    stop: () => stream.stop(),
    subscribe: (resolve, reject) => {
      stream.subscribe(resolve)
      stream.onStatusChange((status) => {
        if (status === "unavailable") reject(new Error(`Order book is unavailable for ${symbol}`))
      })
    },
    timeoutMessage: `Timed out waiting for the ${symbol} order book`,
  })
}

function readEquityQuote(stream: EquityQuoteStream, symbol: string, signal?: AbortSignal): Promise<EquityQuoteUpdate> {
  return streamSnapshot<EquityQuoteUpdate>({
    signal,
    start: () => stream.start(symbol),
    stop: () => stream.stop(),
    subscribe: (resolve) => stream.subscribe(resolve),
    timeoutMessage: `Timed out waiting for an equity quote for ${symbol}`,
  })
}

function streamSnapshot<T>(options: {
  signal?: AbortSignal
  start: () => void
  stop: () => void
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void
  timeoutMessage: string
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T } | { error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      options.stop()
      if ("value" in result) resolve(result.value)
      else reject(result.error)
    }
    const onAbort = () => finish({ error: new Error("Market-data request was cancelled") })
    const timer = setTimeout(() => finish({ error: new Error(options.timeoutMessage) }), STREAM_SNAPSHOT_TIMEOUT_MS)
    options.subscribe((value) => finish({ value }), (error) => finish({ error }))
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    else {
      try {
        options.start()
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
  })
}
