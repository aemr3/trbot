import { z } from "zod"
import type { ChatUsage } from "./session.ts"

export const CHAT_SUBAGENT_MODES = ["single", "parallel", "chain"] as const
export type ChatSubagentMode = (typeof CHAT_SUBAGENT_MODES)[number]

export const CHAT_SUBAGENT_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const
export type ChatSubagentStatus = (typeof CHAT_SUBAGENT_STATUSES)[number]
export type ChatSubagentViewStatus = ChatSubagentStatus | "WAITING_PERMISSION"

export const ChatSubagentUsageSchema: z.ZodType<ChatUsage> = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  costTotal: z.number().nonnegative(),
})

export const ChatSubagentJobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentToolCallId: z.string().nullable(),
  mode: z.enum(CHAT_SUBAGENT_MODES),
  status: z.enum(CHAT_SUBAGENT_STATUSES),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  reasoning: z.string().nullable(),
  automationLabel: z.string().nullable(),
  automationReferenceId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  notifiedAt: z.number().int().nonnegative().nullable(),
})

export type ChatSubagentJob = z.infer<typeof ChatSubagentJobSchema>

export const ChatSubagentTaskSchema = z.object({
  jobId: z.string().min(1),
  index: z.number().int().nonnegative(),
  agent: z.string().min(1),
  taskTemplate: z.string().min(1),
  resolvedTask: z.string().nullable(),
  sessionIds: z.array(z.string().min(1)),
  status: z.enum(CHAT_SUBAGENT_STATUSES),
  result: z.string().nullable(),
  error: z.string().nullable(),
  usage: ChatSubagentUsageSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
})

export type ChatSubagentTask = z.infer<typeof ChatSubagentTaskSchema>

export interface ChatSubagentJobRecord {
  job: ChatSubagentJob
  tasks: ChatSubagentTask[]
}

/** Durable storage boundary for background delegation. */
export interface ChatSubagentStore {
  create(job: ChatSubagentJob, tasks: ChatSubagentTask[], maxOutstanding: number): Promise<boolean>
  outstanding(sessionId: string): Promise<number>
  list(sessionId: string): Promise<ChatSubagentJobRecord[]>
  get(jobId: string): Promise<ChatSubagentJobRecord | null>
  listRecoverable(): Promise<ChatSubagentJobRecord[]>
  putJob(job: ChatSubagentJob): Promise<void>
  putJobIfStatus(job: ChatSubagentJob, expected: ChatSubagentStatus[]): Promise<boolean>
  putTask(task: ChatSubagentTask): Promise<void>
  putTaskIfStatus(task: ChatSubagentTask, expected: ChatSubagentStatus[]): Promise<boolean>
}
