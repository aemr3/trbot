import { eq } from "drizzle-orm"
import { isCandleInterval, isCandleRange } from "../market/candle.ts"
import { isViopOrderKind } from "../trading/order.ts"
import {
  DEFAULT_WATCHLIST_PREFERENCES,
  isInstrumentSort,
  isSortDirection,
  normalizeWatchlistPreferences,
  type WatchlistPreferences,
} from "../screens/watchlist-preferences.ts"
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
    if (!isViopOrderKind(row.orderKind)) return { ...DEFAULT_WATCHLIST_PREFERENCES }

    return normalizeWatchlistPreferences({
      instrumentSort: row.instrumentSort,
      sortDirection: row.sortDirection,
      candleRange: row.candleRange,
      candleInterval: row.candleInterval,
      selectedInstrumentUid: row.selectedInstrumentUid,
      orderKind: row.orderKind,
    })
  }

  put(preferences: WatchlistPreferences): void {
    this.db
      .insert(watchlistPreferences)
      .values({ id: PREFERENCES_ID, ...preferences, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: watchlistPreferences.id,
        set: { ...preferences, updatedAt: Date.now() },
      })
      .run()
  }
}
