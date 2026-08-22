import {
  CANDLE_CHART_TARGETS,
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  DEFAULT_INTERVAL_BY_RANGE,
  DEFAULT_INTERVALS_BY_RANGE,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
} from "@trbot/market/candle.ts"
import { DEPTH_TARGETS, type DepthTarget } from "@trbot/market/depth.ts"
import { isChartIndicator, type ChartIndicator } from "@trbot/market/indicator.ts"
import { VIOP_ORDER_KINDS, type ViopOrderKind } from "@trbot/trading/order.ts"
import { z } from "zod"

export const INSTRUMENT_SORTS = ["change", "volume", "name"] as const
export type InstrumentSort = (typeof INSTRUMENT_SORTS)[number]

export const SORT_DIRECTIONS = ["asc", "desc"] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

export const TRADE_RIGHT_VIEWS = ["news", "chat"] as const
export type TradeRightView = (typeof TRADE_RIGHT_VIEWS)[number]

// Which way a sort reads when it is first picked: the biggest movers and the
// busiest contracts lead, but a list by name reads A to Z.
export const DEFAULT_SORT_DIRECTIONS = {
  change: "desc",
  volume: "desc",
  name: "asc",
} satisfies Record<InstrumentSort, SortDirection>

export function isInstrumentSort(value: string): value is InstrumentSort {
  return INSTRUMENT_SORTS.some((sort) => sort === value)
}

export function isSortDirection(value: string): value is SortDirection {
  return SORT_DIRECTIONS.some((direction) => direction === value)
}

export interface AppPreferences {
  instrumentSort: InstrumentSort
  sortDirection: SortDirection
  candleRange: CandleRange
  candleInterval: CandleInterval
  chartTarget: CandleChartTarget
  /** Which order book the depth panel shows: the stock or the contract. */
  depthTarget: DepthTarget
  chartIndicators: ChartIndicator[]
  selectedInstrumentUid: string | null
  orderKind: ViopOrderKind
  /** The conversation restored when CHAT opens again. */
  selectedMainChatSessionId: string | null
  /** The conversation restored in the chat embedded beside the trading workspace. */
  selectedTradePanelChatSessionId: string | null
  /** Which view is restored beside the trading workspace. */
  selectedTradeRightView: TradeRightView
  /** Whether CHAT expands model reasoning instead of showing only its summary line. */
  showChatThoughts: boolean
}

const RequiredTextSchema = z.string().refine((value) => value.trim().length > 0)
const ChartIndicatorListSchema = z.preprocess(
  (value) => value === null || value === undefined ? [] : value,
  z.array(z.unknown()).transform((values) => values.flatMap((value): ChartIndicator[] => {
    const parsed = z.string().safeParse(value)
    return parsed.success && isChartIndicator(parsed.data) ? [parsed.data] : []
  })),
)

/** Full preferences payload accepted from a client before range normalization. */
export const AppPreferencesSchema: z.ZodType<AppPreferences> = z.object({
  instrumentSort: z.enum(INSTRUMENT_SORTS),
  sortDirection: z.enum(SORT_DIRECTIONS),
  candleRange: z.enum(CANDLE_RANGES),
  candleInterval: z.enum(CANDLE_INTERVALS),
  chartTarget: z.enum(CANDLE_CHART_TARGETS),
  depthTarget: z.enum(DEPTH_TARGETS).default("UNDERLYING"),
  chartIndicators: ChartIndicatorListSchema,
  selectedInstrumentUid: RequiredTextSchema.nullable().default(null),
  orderKind: z.enum(VIOP_ORDER_KINDS),
  selectedMainChatSessionId: RequiredTextSchema.nullable().default(null),
  selectedTradePanelChatSessionId: RequiredTextSchema.nullable().default(null),
  selectedTradeRightView: z.enum(TRADE_RIGHT_VIEWS).default("news"),
  showChatThoughts: z.boolean().default(true),
})

/** Reads the stored indicator list, dropping any name the app no longer draws. */
export function parseChartIndicators(value: string): ChartIndicator[] {
  return value.split(",").map((name) => name.trim()).filter(isChartIndicator)
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  instrumentSort: "volume",
  sortDirection: "desc",
  candleRange: "INTRADAY",
  candleInterval: "MIN_5",
  chartTarget: "UNDERLYING",
  depthTarget: "UNDERLYING",
  chartIndicators: [],
  selectedInstrumentUid: null,
  orderKind: "LIMIT",
  selectedMainChatSessionId: null,
  selectedTradePanelChatSessionId: null,
  selectedTradeRightView: "news",
  showChatThoughts: true,
}

export function normalizeAppPreferences(preferences: AppPreferences): AppPreferences {
  return {
    ...preferences,
    candleInterval: DEFAULT_INTERVALS_BY_RANGE[preferences.candleRange].includes(preferences.candleInterval)
      ? preferences.candleInterval
      : DEFAULT_INTERVAL_BY_RANGE[preferences.candleRange],
  }
}
