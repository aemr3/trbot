import { eq } from "drizzle-orm"
import {
  PriceAlertSchema,
  type PriceAlert,
  type PriceAlertStore,
} from "@trbot/market/alert.ts"
import type { AppDatabase } from "./client.ts"
import { priceAlerts } from "./schema.ts"

// A row whose enums no longer parse is skipped rather than failing the load:
// one unreadable alert must not cost the trader every other one on the list.
export class DrizzlePriceAlertStore implements PriceAlertStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<PriceAlert[]> {
    const rows = await this.db.select().from(priceAlerts)
    return rows.flatMap((row) => {
      const parsed = PriceAlertSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  }

  async put(alert: PriceAlert): Promise<void> {
    const { id: _id, createdAt: _createdAt, ...updates } = alert
    await this.db
      .insert(priceAlerts)
      .values(alert)
      .onConflictDoUpdate({
        target: priceAlerts.id,
        set: updates,
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(priceAlerts).where(eq(priceAlerts.id, id))
  }
}
