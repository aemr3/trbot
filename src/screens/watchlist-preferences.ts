import { DEFAULT_INTERVAL_BY_RANGE, DEFAULT_INTERVALS_BY_RANGE, type CandleInterval, type CandleRange } from "../market/candle.ts"
import type { ViopOrderKind } from "../trading/order.ts"

export const INSTRUMENT_SORTS = ["change", "volume"] as const
export type InstrumentSort = (typeof INSTRUMENT_SORTS)[number]

export const SORT_DIRECTIONS = ["asc", "desc"] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

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
  selectedInstrumentUid: string | null
  orderKind: ViopOrderKind
}

export const DEFAULT_WATCHLIST_PREFERENCES: WatchlistPreferences = {
  instrumentSort: "volume",
  sortDirection: "desc",
  candleRange: "INTRADAY",
  candleInterval: "MIN_5",
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
