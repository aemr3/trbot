import { eq } from "drizzle-orm"
import { isCandleChartTarget, isCandleInterval, isCandleRange } from "@trbot/market/candle.ts"
import { isViopOrderKind } from "@trbot/trading/order.ts"
import {
  DEFAULT_WATCHLIST_PREFERENCES,
  isInstrumentSort,
  isSortDirection,
  normalizeWatchlistPreferences,
  parseChartIndicators,
  type WatchlistPreferences,
} from "@trbot/preferences/watchlist.ts"
import type { AppDatabase } from "./client.ts"
import { watchlistPreferences } from "./schema.ts"

const PREFERENCES_ID = 1

export class DrizzleWatchlistPreferencesStore {
  constructor(private readonly db: AppDatabase) {}

  get(): WatchlistPreferences {
    const row = this.db
      .select()
      .from(watchlistPreferences)
      .where(eq(watchlistPreferences.id, PREFERENCES_ID))
      .get()

    if (!row) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isInstrumentSort(row.instrumentSort)) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isSortDirection(row.sortDirection)) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isCandleRange(row.candleRange)) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isCandleInterval(row.candleInterval)) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isCandleChartTarget(row.chartTarget)) return { ...DEFAULT_WATCHLIST_PREFERENCES }
    if (!isViopOrderKind(row.orderKind)) return { ...DEFAULT_WATCHLIST_PREFERENCES }

    return normalizeWatchlistPreferences({
      instrumentSort: row.instrumentSort,
      sortDirection: row.sortDirection,
      candleRange: row.candleRange,
      candleInterval: row.candleInterval,
      chartTarget: row.chartTarget,
      chartIndicators: parseChartIndicators(row.chartIndicators),
      selectedInstrumentUid: row.selectedInstrumentUid,
      orderKind: row.orderKind,
    })
  }

  put(preferences: WatchlistPreferences): void {
    // The indicator list is the one preference that is not a scalar; it is
    // stored as a name list so a new indicator needs no migration.
    const row = { ...preferences, chartIndicators: preferences.chartIndicators.join(","), updatedAt: Date.now() }
    this.db
      .insert(watchlistPreferences)
      .values({ id: PREFERENCES_ID, ...row })
      .onConflictDoUpdate({ target: watchlistPreferences.id, set: row })
      .run()
  }
}
