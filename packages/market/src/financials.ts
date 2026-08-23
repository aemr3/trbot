import { z } from "zod"

export const FINANCIAL_PERIOD_PATTERN = "^\\d{4}/(?:[1-9]|1[0-2])$"

/** Provider-neutral metric names supported by the recent-financials screener. */
export const FINANCIAL_METRICS = [
  "LAST_PRICE",
  "DAILY_CHANGE_PERCENT",
  "DAILY_VOLUME",
  "MARKET_CAP",
  "FREE_FLOAT_PERCENT",
  "FREE_FLOAT_SHARES",
  "PRICE_TO_EARNINGS",
  "PRICE_TO_BOOK",
  "ENTERPRISE_VALUE_TO_SALES",
  "ENTERPRISE_VALUE_TO_EBITDA",
  "PEG",
  "INVESTOR_COUNT",
  "RETAIL_CUSTODY_PERCENT",
  "INSTITUTIONAL_CUSTODY_PERCENT",
  "RETURN_ON_EQUITY",
  "RETURN_ON_ASSETS",
  "NET_INCOME_MARGIN",
  "EBITDA_MARGIN",
  "GROSS_MARGIN",
  "QUARTERLY_NET_INCOME_MARGIN",
  "QUARTERLY_EBITDA_MARGIN",
  "QUARTERLY_GROSS_MARGIN",
  "NET_INCOME_MARGIN_CHANGE_PERCENT",
  "GROSS_MARGIN_CHANGE_PERCENT",
  "EBITDA_MARGIN_CHANGE_PERCENT",
  "QUARTERLY_NET_INCOME_MARGIN_CHANGE_PERCENT",
  "QUARTERLY_GROSS_MARGIN_CHANGE_PERCENT",
  "RETURN_ON_INVESTED_CAPITAL",
  "LEVERAGE_PERCENT",
  "CURRENT_RATIO",
  "CASH_RATIO",
  "FINANCIAL_DEBT_PERCENT",
  "QUICK_RATIO",
  "NET_DEBT_TO_EBITDA",
  "NET_FX_POSITION_TO_MARKET_CAP",
  "ANNUAL_NET_INCOME_CHANGE_PERCENT",
  "QUARTERLY_NET_INCOME_CHANGE_PERCENT",
  "ANNUAL_EBITDA_CHANGE_PERCENT",
  "QUARTERLY_EBITDA_CHANGE_PERCENT",
  "ANNUAL_REVENUE_CHANGE_PERCENT",
  "QUARTERLY_REVENUE_CHANGE_PERCENT",
  "ANNUAL_OPERATING_CASH_FLOW_CHANGE_PERCENT",
  "REVENUE",
  "QUARTERLY_REVENUE",
  "COST_OF_REVENUE",
  "GROSS_PROFIT",
  "OPERATING_EXPENSES",
  "DEPRECIATION_AND_AMORTIZATION",
  "EBITDA",
  "QUARTERLY_EBITDA",
  "OPERATING_PROFIT",
  "NET_FINANCE_EXPENSE",
  "PRE_TAX_INCOME",
  "TAX_EXPENSE",
  "NET_INCOME",
  "QUARTERLY_NET_INCOME",
  "EARNINGS_PER_SHARE",
  "RESEARCH_AND_DEVELOPMENT_EXPENSES",
  "GENERAL_AND_ADMINISTRATIVE_EXPENSES",
  "MARKETING_EXPENSES",
  "EXPORT_PERCENT",
  "NET_MONETARY_POSITION_GAIN_LOSS",
  "CASH_AND_EQUIVALENTS",
  "TRADE_RECEIVABLES",
  "INVENTORY",
  "CURRENT_ASSETS",
  "FINANCIAL_DEBT",
  "FINANCIAL_INVESTMENTS",
  "PROPERTY_PLANT_AND_EQUIPMENT",
  "INTANGIBLE_ASSETS",
  "NON_CURRENT_ASSETS",
  "TOTAL_ASSETS",
  "TRADE_PAYABLES",
  "CURRENT_LIABILITIES",
  "NON_CURRENT_LIABILITIES",
  "TOTAL_LIABILITIES",
  "RETAINED_EARNINGS",
  "EQUITY",
  "PAID_IN_CAPITAL",
  "NET_FX_POSITION",
  "NET_DEBT",
  "SHORT_TERM_FINANCIAL_DEBT",
  "LONG_TERM_FINANCIAL_DEBT",
  "CHANGE_IN_WORKING_CAPITAL",
  "OPERATING_CASH_FLOW",
  "CAPITAL_EXPENDITURES",
  "INVESTING_CASH_FLOW",
  "DIVIDENDS_PAID",
  "FINANCING_CASH_FLOW",
  "CHANGE_IN_CASH",
  "ANNUALIZED_FREE_CASH_FLOW",
  "QUARTERLY_FREE_CASH_FLOW",
  "ASSET_TURNOVER",
  "RECEIVABLES_TURNOVER",
  "PAYABLES_TURNOVER",
  "INVENTORY_TURNOVER",
  "EQUITY_TURNOVER",
] as const

export type FinancialMetric = (typeof FINANCIAL_METRICS)[number]

export const FinancialMetricSchema = z.enum(FINANCIAL_METRICS)

/** Compact default for trading decisions; every other metric remains explicitly selectable. */
export const DEFAULT_FINANCIAL_METRICS = [
  "LAST_PRICE",
  "DAILY_CHANGE_PERCENT",
  "DAILY_VOLUME",
  "MARKET_CAP",
  "FREE_FLOAT_PERCENT",
  "PRICE_TO_EARNINGS",
  "PRICE_TO_BOOK",
  "ENTERPRISE_VALUE_TO_EBITDA",
  "RETURN_ON_EQUITY",
  "EBITDA_MARGIN",
  "QUARTERLY_EBITDA_MARGIN",
  "RETURN_ON_INVESTED_CAPITAL",
  "CURRENT_RATIO",
  "NET_DEBT_TO_EBITDA",
  "ANNUAL_NET_INCOME_CHANGE_PERCENT",
  "QUARTERLY_NET_INCOME_CHANGE_PERCENT",
  "ANNUAL_EBITDA_CHANGE_PERCENT",
  "QUARTERLY_EBITDA_CHANGE_PERCENT",
  "ANNUAL_REVENUE_CHANGE_PERCENT",
  "QUARTERLY_REVENUE_CHANGE_PERCENT",
  "EARNINGS_PER_SHARE",
  "ANNUALIZED_FREE_CASH_FLOW",
] as const satisfies readonly FinancialMetric[]

export type FinancialMetricValues = Partial<Record<FinancialMetric, number | null>>

export const FinancialMetricValuesSchema: z.ZodType<FinancialMetricValues> = z.partialRecord(
  FinancialMetricSchema,
  z.number().nullable(),
)

/** One company's latest filing and the requested market or financial metrics. */
export interface RecentFinancial {
  symbol: string
  publishedAt: string
  period: string
  metrics: FinancialMetricValues
}

export const RecentFinancialSchema: z.ZodType<RecentFinancial> = z.object({
  symbol: z.string().min(1),
  publishedAt: z.string().min(1),
  period: z.string().regex(new RegExp(FINANCIAL_PERIOD_PATTERN)),
  metrics: FinancialMetricValuesSchema,
})

/** Financials available through the current front-month VIOP equity universe. */
export interface RecentFinancialSet {
  universe: "VIOP_EQUITIES"
  eligibleSymbols: string[]
  metrics: FinancialMetric[]
  financials: RecentFinancial[]
}

export const RecentFinancialSetSchema: z.ZodType<RecentFinancialSet> = z.object({
  universe: z.literal("VIOP_EQUITIES"),
  eligibleSymbols: z.array(z.string().min(1)),
  metrics: z.array(FinancialMetricSchema),
  financials: z.array(RecentFinancialSchema),
})

export interface RecentFinancialRequest {
  /** Omit for each company's latest available filing. */
  period?: string
  /** Cash-equity symbols only; every symbol must be a current VIOP equity underlying. */
  symbols?: string[]
  /** Omit for the compact trading default. */
  metrics?: FinancialMetric[]
  signal?: AbortSignal
}

export interface RecentFinancialSource {
  listRecentFinancials(request?: RecentFinancialRequest): Promise<RecentFinancialSet>
}
