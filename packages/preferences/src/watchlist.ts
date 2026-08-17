import {
  DEFAULT_INTERVAL_BY_RANGE,
  DEFAULT_INTERVALS_BY_RANGE,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
} from "@trbot/market/candle.ts"
import { isChartIndicator, type ChartIndicator } from "@trbot/market/indicator.ts"
import type { ViopOrderKind } from "@trbot/trading/order.ts"

export const INSTRUMENT_SORTS = ["change", "volume", "name"] as const
export type InstrumentSort = (typeof INSTRUMENT_SORTS)[number]

export const SORT_DIRECTIONS = ["asc", "desc"] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

// Which way a sort reads when it is first picked: the biggest movers and the
// busiest contracts lead, but a list by name reads A to Z.
export const DEFAULT_SORT_DIRECTIONS: Record<InstrumentSort, SortDirection> = {
  change: "desc",
  volume: "desc",
  name: "asc",
}

export function isInstrumentSort(value: string): value is InstrumentSort {
  return INSTRUMENT_SORTS.some((sort) => sort === value)
}

export function isSortDirection(value: string): value is SortDirection {
  return SORT_DIRECTIONS.some((direction) => direction === value)
}

export interface WatchlistPreferences {
  instrumentSort: InstrumentSort
  sortDirection: SortDirection
  candleRange: CandleRange
  candleInterval: CandleInterval
  chartTarget: CandleChartTarget
  chartIndicators: ChartIndicator[]
  selectedInstrumentUid: string | null
  orderKind: ViopOrderKind
}

/** Reads the stored indicator list, dropping any name the app no longer draws. */
export function parseChartIndicators(value: string): ChartIndicator[] {
  return value.split(",").map((name) => name.trim()).filter(isChartIndicator)
}

export const DEFAULT_WATCHLIST_PREFERENCES: WatchlistPreferences = {
  instrumentSort: "volume",
  sortDirection: "desc",
  candleRange: "INTRADAY",
  candleInterval: "MIN_5",
  chartTarget: "UNDERLYING",
  chartIndicators: [],
  selectedInstrumentUid: null,
  orderKind: "LIMIT",
}

export function normalizeWatchlistPreferences(preferences: WatchlistPreferences): WatchlistPreferences {
  return {
    ...preferences,
    candleInterval: DEFAULT_INTERVALS_BY_RANGE[preferences.candleRange].includes(preferences.candleInterval)
      ? preferences.candleInterval
      : DEFAULT_INTERVAL_BY_RANGE[preferences.candleRange],
  }
}
