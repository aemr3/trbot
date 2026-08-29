import { eq } from "drizzle-orm"
import {
  MarketMonitorSchema,
  type MarketMonitor,
  type MarketMonitorStore,
} from "@trbot/market/market-monitor.ts"
import type { AppDatabase } from "./client.ts"
import { marketMonitors } from "./schema.ts"

/** Persists agent monitors independently from the user's price alerts. */
export class DrizzleMarketMonitorStore implements MarketMonitorStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<MarketMonitor[]> {
    const rows = await this.db.select().from(marketMonitors)
    return rows.flatMap((row) => {
      const parsed = MarketMonitorSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  }

  async put(monitor: MarketMonitor): Promise<void> {
    const { id: _id, createdAt: _createdAt, ...updates } = monitor
    await this.db
      .insert(marketMonitors)
      .values(monitor)
      .onConflictDoUpdate({
        target: marketMonitors.id,
        set: updates,
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(marketMonitors).where(eq(marketMonitors.id, id))
  }
}
