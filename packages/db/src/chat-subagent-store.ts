import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm"
import {
  ChatSubagentJobSchema,
  ChatSubagentTaskSchema,
  type ChatSubagentJob,
  type ChatSubagentJobRecord,
  type ChatSubagentStore,
  type ChatSubagentTask,
} from "@trbot/chat/subagent.ts"
import type { AppDatabase } from "./client.ts"
import { chatSubagentJobs, chatSubagentTasks } from "./schema.ts"

const OUTSTANDING = ["QUEUED", "RUNNING"] as const

/** Drizzle-backed background delegation jobs and their independently recoverable tasks. */
export class DrizzleChatSubagentStore implements ChatSubagentStore {
  constructor(private readonly db: AppDatabase) {}

  async create(job: ChatSubagentJob, tasks: ChatSubagentTask[], maxOutstanding: number): Promise<boolean> {
    return this.db.transaction((tx) => {
      const outstanding = tx
        .select({ value: count() })
        .from(chatSubagentTasks)
        .innerJoin(chatSubagentJobs, eq(chatSubagentTasks.jobId, chatSubagentJobs.id))
        .where(and(
          eq(chatSubagentJobs.sessionId, job.sessionId),
          inArray(chatSubagentTasks.status, OUTSTANDING),
        ))
        .get()?.value ?? 0
      if (outstanding + tasks.length > maxOutstanding) return false

      tx.insert(chatSubagentJobs).values(jobRow(job)).run()
      if (tasks.length > 0) tx.insert(chatSubagentTasks).values(tasks.map(taskRow)).run()
      return true
    })
  }

  async outstanding(sessionId: string): Promise<number> {
    return this.db
      .select({ value: count() })
      .from(chatSubagentTasks)
      .innerJoin(chatSubagentJobs, eq(chatSubagentTasks.jobId, chatSubagentJobs.id))
      .where(and(
        eq(chatSubagentJobs.sessionId, sessionId),
        inArray(chatSubagentTasks.status, OUTSTANDING),
      ))
      .get()?.value ?? 0
  }

  async list(sessionId: string): Promise<ChatSubagentJobRecord[]> {
    const jobs = await this.db
      .select()
      .from(chatSubagentJobs)
      .where(eq(chatSubagentJobs.sessionId, sessionId))
      .orderBy(desc(chatSubagentJobs.createdAt))
    return await Promise.all(jobs.map((row) => this.record(jobFromRow(row))))
  }

  async get(jobId: string): Promise<ChatSubagentJobRecord | null> {
    const row = this.db.select().from(chatSubagentJobs).where(eq(chatSubagentJobs.id, jobId)).limit(1).get()
    return row ? await this.record(jobFromRow(row)) : null
  }

  async listRecoverable(): Promise<ChatSubagentJobRecord[]> {
    const jobs = await this.db
      .select()
      .from(chatSubagentJobs)
      .where(or(
        inArray(chatSubagentJobs.status, OUTSTANDING),
        and(
          inArray(chatSubagentJobs.status, ["COMPLETED", "FAILED", "CANCELLED"]),
          isNull(chatSubagentJobs.notifiedAt),
        ),
      ))
      .orderBy(asc(chatSubagentJobs.createdAt))
    return await Promise.all(jobs.map((row) => this.record(jobFromRow(row))))
  }

  async putJob(job: ChatSubagentJob): Promise<void> {
    await this.db.insert(chatSubagentJobs).values(jobRow(job)).onConflictDoUpdate({
      target: chatSubagentJobs.id,
      set: jobRow(job),
    })
  }

  async putJobIfStatus(job: ChatSubagentJob, expected: ChatSubagentJob["status"][]): Promise<boolean> {
    const row = this.db
      .update(chatSubagentJobs)
      .set(jobRow(job))
      .where(and(eq(chatSubagentJobs.id, job.id), inArray(chatSubagentJobs.status, expected)))
      .returning({ id: chatSubagentJobs.id })
      .get()
    return row !== undefined
  }

  async putTask(task: ChatSubagentTask): Promise<void> {
    await this.db.insert(chatSubagentTasks).values(taskRow(task)).onConflictDoUpdate({
      target: [chatSubagentTasks.jobId, chatSubagentTasks.index],
      set: taskRow(task),
    })
  }

  async putTaskIfStatus(task: ChatSubagentTask, expected: ChatSubagentTask["status"][]): Promise<boolean> {
    const row = this.db
      .update(chatSubagentTasks)
      .set(taskRow(task))
      .where(and(
        eq(chatSubagentTasks.jobId, task.jobId),
        eq(chatSubagentTasks.index, task.index),
        inArray(chatSubagentTasks.status, expected),
      ))
      .returning({ jobId: chatSubagentTasks.jobId })
      .get()
    return row !== undefined
  }

  private async record(job: ChatSubagentJob): Promise<ChatSubagentJobRecord> {
    const rows = await this.db
      .select()
      .from(chatSubagentTasks)
      .where(eq(chatSubagentTasks.jobId, job.id))
      .orderBy(asc(chatSubagentTasks.index))
    return { job, tasks: rows.map(taskFromRow) }
  }
}

type JobRow = typeof chatSubagentJobs.$inferSelect
type TaskRow = typeof chatSubagentTasks.$inferSelect

function jobRow(job: ChatSubagentJob): typeof chatSubagentJobs.$inferInsert {
  return job
}

function jobFromRow(row: JobRow): ChatSubagentJob {
  return ChatSubagentJobSchema.parse(row)
}

function taskRow(task: ChatSubagentTask): typeof chatSubagentTasks.$inferInsert {
  return {
    jobId: task.jobId,
    index: task.index,
    agent: task.agent,
    taskTemplate: task.taskTemplate,
    resolvedTask: task.resolvedTask,
    sessionIds: JSON.stringify(task.sessionIds),
    status: task.status,
    result: task.result,
    error: task.error,
    inputTokens: task.usage?.inputTokens ?? null,
    outputTokens: task.usage?.outputTokens ?? null,
    totalTokens: task.usage?.totalTokens ?? null,
    costTotal: task.usage?.costTotal ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  }
}

function taskFromRow(row: TaskRow): ChatSubagentTask {
  const hasUsage = row.inputTokens !== null
    && row.outputTokens !== null
    && row.totalTokens !== null
    && row.costTotal !== null
  return ChatSubagentTaskSchema.parse({
    jobId: row.jobId,
    index: row.index,
    agent: row.agent,
    taskTemplate: row.taskTemplate,
    resolvedTask: row.resolvedTask,
    sessionIds: JSON.parse(row.sessionIds),
    status: row.status,
    result: row.result,
    error: row.error,
    usage: hasUsage
      ? {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          totalTokens: row.totalTokens,
          costTotal: row.costTotal,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  })
}
