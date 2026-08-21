import { and, asc, eq, lte } from "drizzle-orm"
import {
  ChatGoalSchema,
  ChatLoopSchema,
  type ChatAutomationStore,
  type ChatGoal,
  type ChatLoop,
} from "@trbot/chat/automation.ts"
import type { AppDatabase } from "./client.ts"
import { chatGoals, chatLoops } from "./schema.ts"

/** Durable goals and scheduled chat continuations. */
export class DrizzleChatAutomationStore implements ChatAutomationStore {
  constructor(private readonly db: AppDatabase) {}

  async getGoal(sessionId: string): Promise<ChatGoal | null> {
    const row = this.db.select().from(chatGoals).where(eq(chatGoals.sessionId, sessionId)).limit(1).get()
    return row ? goalFromRow(row) : null
  }

  async listActiveGoals(): Promise<ChatGoal[]> {
    const rows = await this.db.select().from(chatGoals).where(eq(chatGoals.status, "ACTIVE"))
    return rows.map(goalFromRow)
  }

  async putGoal(goal: ChatGoal): Promise<void> {
    const row = goal
    await this.db.insert(chatGoals).values(row).onConflictDoUpdate({
      target: chatGoals.sessionId,
      set: row,
    })
  }

  async removeGoal(sessionId: string): Promise<void> {
    await this.db.delete(chatGoals).where(eq(chatGoals.sessionId, sessionId))
  }

  async listLoops(sessionId?: string): Promise<ChatLoop[]> {
    const query = this.db.select().from(chatLoops)
    const rows = sessionId
      ? await query.where(eq(chatLoops.sessionId, sessionId)).orderBy(asc(chatLoops.createdAt))
      : await query.orderBy(asc(chatLoops.createdAt))
    return rows.map(loopFromRow)
  }

  async listDueLoops(now: number): Promise<ChatLoop[]> {
    const rows = await this.db
      .select()
      .from(chatLoops)
      .where(and(eq(chatLoops.status, "ACTIVE"), lte(chatLoops.nextRunAt, now)))
      .orderBy(asc(chatLoops.nextRunAt))
    return rows.map(loopFromRow)
  }

  async putLoop(loop: ChatLoop): Promise<void> {
    const row = loop
    await this.db.insert(chatLoops).values(row).onConflictDoUpdate({ target: chatLoops.id, set: row })
  }

  async removeLoop(id: string): Promise<void> {
    await this.db.delete(chatLoops).where(eq(chatLoops.id, id))
  }
}

type GoalRow = typeof chatGoals.$inferSelect
type LoopRow = typeof chatLoops.$inferSelect

function goalFromRow(row: GoalRow): ChatGoal {
  return ChatGoalSchema.parse(row)
}

function loopFromRow(row: LoopRow): ChatLoop {
  return ChatLoopSchema.parse(row)
}
