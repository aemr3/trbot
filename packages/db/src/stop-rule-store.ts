import { eq } from "drizzle-orm"
import { isCandleInterval } from "@trbot/market/candle.ts"
import {
  isStopPositionSide,
  isStopRuleBasis,
  isStopRuleKind,
  isStopRuleRole,
  isStopRuleStatus,
  type StopRule,
  type StopRuleStore,
} from "@trbot/trading/stop.ts"
import type { AppDatabase } from "./client.ts"
import { stopRules } from "./schema.ts"

// A row whose enums no longer parse is skipped rather than failing the load:
// one unreadable rule must not cost the trader every other stop on the list.
export class DrizzleStopRuleStore implements StopRuleStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<StopRule[]> {
    const rows = await this.db.select().from(stopRules)
    const rules: StopRule[] = []
    for (const row of rows) {
      const rule = toStopRule(row)
      if (rule) rules.push(rule)
    }
    return rules
  }

  async put(rule: StopRule): Promise<void> {
    await this.db
      .insert(stopRules)
      .values(rule)
      .onConflictDoUpdate({
        target: stopRules.id,
        set: {
          instrumentUid: rule.instrumentUid,
          symbol: rule.symbol,
          displayName: rule.displayName,
          side: rule.side,
          role: rule.role,
          kind: rule.kind,
          value: rule.value,
          basis: rule.basis,
          interval: rule.interval,
          quantity: rule.quantity,
          status: rule.status,
          triggerPrice: rule.triggerPrice,
          extremePrice: rule.extremePrice,
          referencePrice: rule.referencePrice,
          atrValue: rule.atrValue,
          updatedAt: rule.updatedAt,
          triggeredAt: rule.triggeredAt,
          exitOrderUid: rule.exitOrderUid,
        },
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(stopRules).where(eq(stopRules.id, id))
  }
}

function toStopRule(row: typeof stopRules.$inferSelect): StopRule | null {
  if (!isStopPositionSide(row.side) || !isStopRuleRole(row.role) || !isStopRuleKind(row.kind)) return null
  if (!isStopRuleBasis(row.basis) || !isStopRuleStatus(row.status)) return null
  if (row.interval !== null && !isCandleInterval(row.interval)) return null
  return {
    id: row.id,
    instrumentUid: row.instrumentUid,
    symbol: row.symbol,
    displayName: row.displayName,
    side: row.side,
    role: row.role,
    kind: row.kind,
    value: row.value,
    basis: row.basis,
    interval: row.interval,
    quantity: row.quantity,
    status: row.status,
    triggerPrice: row.triggerPrice,
    extremePrice: row.extremePrice,
    referencePrice: row.referencePrice,
    atrValue: row.atrValue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggeredAt: row.triggeredAt,
    exitOrderUid: row.exitOrderUid,
  }
}
