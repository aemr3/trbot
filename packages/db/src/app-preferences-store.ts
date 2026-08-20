import { eq } from "drizzle-orm"
import { isCandleChartTarget, isCandleInterval, isCandleRange } from "@trbot/market/candle.ts"
import { isViopOrderKind } from "@trbot/trading/order.ts"
import {
  DEFAULT_APP_PREFERENCES,
  isInstrumentSort,
  isSortDirection,
  normalizeAppPreferences,
  parseChartIndicators,
  type AppPreferences,
} from "@trbot/preferences/app.ts"
import type { AppDatabase } from "./client.ts"
import { appPreferences } from "./schema.ts"

const PREFERENCES_ID = 1

export class DrizzleAppPreferencesStore {
  constructor(private readonly db: AppDatabase) {}

  get(): AppPreferences {
    const row = this.db
      .select()
      .from(appPreferences)
      .where(eq(appPreferences.id, PREFERENCES_ID))
      .get()

    if (!row) return { ...DEFAULT_APP_PREFERENCES }
    if (!isInstrumentSort(row.instrumentSort)) return { ...DEFAULT_APP_PREFERENCES }
    if (!isSortDirection(row.sortDirection)) return { ...DEFAULT_APP_PREFERENCES }
    if (!isCandleRange(row.candleRange)) return { ...DEFAULT_APP_PREFERENCES }
    if (!isCandleInterval(row.candleInterval)) return { ...DEFAULT_APP_PREFERENCES }
    if (!isCandleChartTarget(row.chartTarget)) return { ...DEFAULT_APP_PREFERENCES }
    if (!isViopOrderKind(row.orderKind)) return { ...DEFAULT_APP_PREFERENCES }

    return normalizeAppPreferences({
      instrumentSort: row.instrumentSort,
      sortDirection: row.sortDirection,
      candleRange: row.candleRange,
      candleInterval: row.candleInterval,
      chartTarget: row.chartTarget,
      chartIndicators: parseChartIndicators(row.chartIndicators),
      selectedInstrumentUid: row.selectedInstrumentUid,
      orderKind: row.orderKind,
      selectedMainChatSessionId: row.selectedMainChatSessionId,
      selectedTradePanelChatSessionId: row.selectedTradePanelChatSessionId,
      selectedTradeRightView: row.selectedTradeRightView,
      showChatThoughts: row.showChatThoughts,
    })
  }

  put(preferences: AppPreferences): void {
    // The indicator list is the one preference that is not a scalar; it is
    // stored as a name list so a new indicator needs no migration.
    const row = { ...preferences, chartIndicators: preferences.chartIndicators.join(","), updatedAt: Date.now() }
    this.db
      .insert(appPreferences)
      .values({ id: PREFERENCES_ID, ...row })
      .onConflictDoUpdate({ target: appPreferences.id, set: row })
      .run()
  }
}
