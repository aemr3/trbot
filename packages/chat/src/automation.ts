import { z } from "zod"

export const CHAT_GOAL_STATUSES = ["ACTIVE", "PAUSED", "BLOCKED", "COMPLETE"] as const

export const CHAT_LOOP_STATUSES = ["ACTIVE", "PAUSED", "COMPLETE"] as const

export const ChatGoalSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(CHAT_GOAL_STATUSES),
  turnCount: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive().nullable(),
  tokenBudget: z.number().int().positive().nullable(),
  startedTokens: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  lastEvaluation: z.string().nullable(),
  pendingEventKey: z.string().nullable(),
  failureCount: z.number().int().nonnegative().default(0),
  retryAt: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export type ChatGoal = z.infer<typeof ChatGoalSchema>

const ChatLoopCommon = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  usesDefaultPrompt: z.boolean(),
  status: z.enum(CHAT_LOOP_STATUSES),
  nextRunAt: z.number().int().nonnegative(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  runCount: z.number().int().nonnegative(),
  maxRuns: z.number().int().positive().nullable(),
  expiresAt: z.number().int().positive().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}

export const ChatLoopSchema = z.discriminatedUnion("schedule", [
  z.object({
    ...ChatLoopCommon,
    schedule: z.literal("INTERVAL"),
    intervalMs: z.number().int().positive(),
    cronExpression: z.null(),
  }),
  z.object({
    ...ChatLoopCommon,
    schedule: z.literal("DYNAMIC"),
    intervalMs: z.number().int().min(60_000).max(3_600_000),
    cronExpression: z.null(),
  }),
  z.object({
    ...ChatLoopCommon,
    schedule: z.literal("CRON"),
    intervalMs: z.null(),
    cronExpression: z.string().min(1),
  }),
  z.object({
    ...ChatLoopCommon,
    schedule: z.literal("ONCE"),
    intervalMs: z.null(),
    cronExpression: z.null(),
  }),
])

export type ChatLoop = z.infer<typeof ChatLoopSchema>

export const ChatAutomationStateSchema = z.object({
  goal: ChatGoalSchema.nullable(),
  loops: z.array(ChatLoopSchema),
})

export type ChatAutomationState = z.infer<typeof ChatAutomationStateSchema>

export const ChatGoalEvaluationSchema = z.object({
  verdict: z.enum(["CONTINUE", "COMPLETE", "IMPOSSIBLE"]),
  reason: z.string().trim().min(1).max(1_000),
})

export type ChatGoalEvaluation = z.infer<typeof ChatGoalEvaluationSchema>

export const CreateChatGoalSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  maxTurns: z.number().int().positive().max(500).optional(),
  tokenBudget: z.number().int().positive().optional(),
})

export type CreateChatGoal = z.infer<typeof CreateChatGoalSchema>

export const UpdateChatGoalSchema = z.object({
  action: z.enum(["PAUSE", "RESUME", "CLEAR"]),
})

export type UpdateChatGoal = z.infer<typeof UpdateChatGoalSchema>

const CreateChatLoopCommon = {
  prompt: z.string().trim().min(1).max(4_000).optional(),
  maxRuns: z.number().int().positive().optional(),
  expiresAt: z.number().int().positive().optional(),
}

export const CreateChatLoopSchema = z.discriminatedUnion("schedule", [
  z.object({
    ...CreateChatLoopCommon,
    schedule: z.literal("INTERVAL"),
    intervalMs: z.number().int().min(60_000),
  }),
  z.object({
    ...CreateChatLoopCommon,
    schedule: z.literal("DYNAMIC"),
    initialDelayMs: z.number().int().min(60_000).max(3_600_000).optional(),
  }),
  z.object({
    ...CreateChatLoopCommon,
    schedule: z.literal("CRON"),
    cronExpression: z.string().trim().min(1).max(200),
  }),
  z.object({
    ...CreateChatLoopCommon,
    schedule: z.literal("ONCE"),
    runAt: z.number().int().positive(),
  }),
])

export type CreateChatLoop = z.infer<typeof CreateChatLoopSchema>

export interface ChatAutomationStore {
  getGoal(sessionId: string): Promise<ChatGoal | null>
  listActiveGoals(): Promise<ChatGoal[]>
  putGoal(goal: ChatGoal): Promise<void>
  removeGoal(sessionId: string): Promise<void>
  listLoops(sessionId?: string): Promise<ChatLoop[]>
  listDueLoops(now: number): Promise<ChatLoop[]>
  putLoop(loop: ChatLoop): Promise<void>
  removeLoop(id: string): Promise<void>
}

const INTERVAL = /^(\d+)(s|m|h|d)$/iu

/** Parses `/loop` durations. Seconds round up because schedules have minute granularity. */
export function parseLoopInterval(value: string): number | null {
  const match = value.trim().match(INTERVAL)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const interval = amount * multiplier
  if (!Number.isSafeInteger(interval) || interval <= 0) return null
  return Math.max(60_000, Math.ceil(interval / 60_000) * 60_000)
}
