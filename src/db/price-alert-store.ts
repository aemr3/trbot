import { eq } from "drizzle-orm"
import {
  isPriceAlertBasis,
  isPriceAlertKind,
  isPriceAlertStatus,
  type PriceAlert,
  type PriceAlertStore,
} from "../market/alert.ts"
import { isCandleInterval } from "../market/candle.ts"
import { isLevelDirection } from "../market/price-level.ts"
import type { AppDatabase } from "./client.ts"
import { priceAlerts } from "./schema.ts"

// A row whose enums no longer parse is skipped rather than failing the load:
// one unreadable alert must not cost the trader every other one on the list.
export class DrizzlePriceAlertStore implements PriceAlertStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<PriceAlert[]> {
    const rows = await this.db.select().from(priceAlerts)
    const alerts: PriceAlert[] = []
    for (const row of rows) {
      const alert = toPriceAlert(row)
      if (alert) alerts.push(alert)
    }
    return alerts
  }

  async put(alert: PriceAlert): Promise<void> {
    await this.db
      .insert(priceAlerts)
      .values(alert)
      .onConflictDoUpdate({
        target: priceAlerts.id,
        set: {
          instrumentUid: alert.instrumentUid,
          symbol: alert.symbol,
          displayName: alert.displayName,
          direction: alert.direction,
          kind: alert.kind,
          value: alert.value,
          basis: alert.basis,
          interval: alert.interval,
          status: alert.status,
          triggerPrice: alert.triggerPrice,
          extremePrice: alert.extremePrice,
          referencePrice: alert.referencePrice,
          atrValue: alert.atrValue,
          updatedAt: alert.updatedAt,
          triggeredAt: alert.triggeredAt,
          triggeredPrice: alert.triggeredPrice,
        },
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(priceAlerts).where(eq(priceAlerts.id, id))
  }
}

function toPriceAlert(row: typeof priceAlerts.$inferSelect): PriceAlert | null {
  if (!isLevelDirection(row.direction) || !isPriceAlertKind(row.kind)) return null
  if (!isPriceAlertBasis(row.basis) || !isPriceAlertStatus(row.status)) return null
  if (row.interval !== null && !isCandleInterval(row.interval)) return null
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
    status: row.status,
    triggerPrice: row.triggerPrice,
    extremePrice: row.extremePrice,
    referencePrice: row.referencePrice,
    atrValue: row.atrValue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggeredAt: row.triggeredAt,
    triggeredPrice: row.triggeredPrice,
  }
}
