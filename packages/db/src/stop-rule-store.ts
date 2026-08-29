import { eq } from "drizzle-orm"
import {
  StopRuleSchema,
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
    return rows.flatMap((row) => {
      const parsed = StopRuleSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  }

  async put(rule: StopRule): Promise<void> {
    const { id: _id, createdAt: _createdAt, ...updates } = rule
    await this.db
      .insert(stopRules)
      .values(rule)
      .onConflictDoUpdate({
        target: stopRules.id,
        set: updates,
      })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(stopRules).where(eq(stopRules.id, id))
  }
}
