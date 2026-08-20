import { eq } from "drizzle-orm"
import {
  isPriceAlertBasis,
  isPriceAlertKind,
  isPriceAlertRepeat,
  isPriceAlertStatus,
} from "@trbot/market/alert.ts"
import { isCandleInterval } from "@trbot/market/candle.ts"
import type { MarketMonitor, MarketMonitorStore } from "@trbot/market/market-monitor.ts"
import { isLevelDirection } from "@trbot/market/price-level.ts"
import type { AppDatabase } from "./client.ts"
import { marketMonitors } from "./schema.ts"

/** Persists agent monitors independently from the user's price alerts. */
export class DrizzleMarketMonitorStore implements MarketMonitorStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<MarketMonitor[]> {
    const rows = await this.db.select().from(marketMonitors)
    return rows.flatMap((row) => {
      const monitor = toMarketMonitor(row)
      return monitor ? [monitor] : []
    })
  }

  async put(monitor: MarketMonitor): Promise<void> {
    await this.db
      .insert(marketMonitors)
      .values(monitor)
      .onConflictDoUpdate({
        target: marketMonitors.id,
        set: {
          instrumentUid: monitor.instrumentUid,
          symbol: monitor.symbol,
          displayName: monitor.displayName,
          direction: monitor.direction,
          kind: monitor.kind,
          value: monitor.value,
          basis: monitor.basis,
          interval: monitor.interval,
          repeat: monitor.repeat,
          status: monitor.status,
          triggerPrice: monitor.triggerPrice,
          extremePrice: monitor.extremePrice,
          referencePrice: monitor.referencePrice,
          atrValue: monitor.atrValue,
          updatedAt: monitor.updatedAt,
          triggeredAt: monitor.triggeredAt,
          triggeredPrice: monitor.triggeredPrice,
          chatSessionId: monitor.chatSessionId,
          onTrigger: monitor.onTrigger,
          triggerId: monitor.triggerId,
        },
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(marketMonitors).where(eq(marketMonitors.id, id))
  }
}

function toMarketMonitor(row: typeof marketMonitors.$inferSelect): MarketMonitor | null {
  if (!isLevelDirection(row.direction) || !isPriceAlertKind(row.kind)) return null
  if (!isPriceAlertBasis(row.basis) || !isPriceAlertStatus(row.status)) return null
  if (!isPriceAlertRepeat(row.repeat)) return null
  if (row.interval !== null && !isCandleInterval(row.interval)) return null
  if (!row.chatSessionId.trim() || !row.onTrigger.trim()) return null
  return {
    id: row.id,
    instrumentUid: row.instrumentUid,
    symbol: row.symbol,
    displayName: row.displayName,
    direction: row.direction,
    kind: row.kind,
    value: row.value,
    basis: row.basis,
    interval: row.interval,
    repeat: row.repeat,
    status: row.status,
    triggerPrice: row.triggerPrice,
    extremePrice: row.extremePrice,
    referencePrice: row.referencePrice,
    atrValue: row.atrValue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggeredAt: row.triggeredAt,
    triggeredPrice: row.triggeredPrice,
    chatSessionId: row.chatSessionId,
    onTrigger: row.onTrigger,
    triggerId: row.triggerId,
  }
}
