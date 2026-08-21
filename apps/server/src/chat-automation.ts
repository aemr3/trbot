import type { ChatGoalEvaluatorRunner } from "@trbot/ai/goal-evaluator.ts"
import {
  type ChatAutomationState,
  type ChatAutomationStore,
  type ChatGoal,
  type ChatLoop,
  type CreateChatGoal,
  type CreateChatLoop,
  type UpdateChatGoal,
} from "@trbot/chat/automation.ts"
import { isValidCronExpression, nextCronOccurrence } from "@trbot/chat/schedule.ts"
import type { ChatApplicationEvent, ChatSessionDetail } from "@trbot/chat/session.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatTurnModel } from "@trbot/ai/chat.ts"

const DEFAULT_MAX_GOAL_TURNS = 50
const LOOP_POLL_MS = 15_000
const EVIDENCE_MESSAGES = 16
const MAX_SCHEDULED_TASKS = 50
const RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60_000
const DEFAULT_DYNAMIC_DELAY_MS = 60_000

export const DEFAULT_LOOP_PROMPT = [
  "Continue unfinished work from this conversation.",
  "Review any active position, monitor, or analysis the user already asked you to tend.",
  "If nothing needs action, report that briefly without starting a new initiative.",
].join(" ")

export interface ChatAutomationControllerOptions {
  store: ChatAutomationStore
  detail: (sessionId: string) => Promise<ChatSessionDetail>
  enqueueEvent: (sessionId: string, event: ChatApplicationEvent) => Promise<void>
  cancelQueuedEvents?: (sessionId: string, label: string, referenceId: string) => Promise<void>
  resolveModel: (detail: ChatSessionDetail) => Promise<ChatTurnModel>
  evaluator: ChatGoalEvaluatorRunner
  defaultLoopPrompt?: () => Promise<string | null>
  notify?: (input: { sessionId: string; title: string; message: string }) => Promise<void>
  onError: (cause: unknown) => void
  now?: () => number
  pollMs?: number
}

/** Owns durable goal continuation and wall-clock chat wake-ups. */
export class ChatAutomationController {
  private readonly now: () => number
  private readonly pollMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private destroyed = false

  constructor(private readonly options: ChatAutomationControllerOptions) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? LOOP_POLL_MS
  }

  async start(): Promise<void> {
    await this.tick()
    await this.resumeGoals()
    if (!this.destroyed) this.timer = setInterval(() => void this.tick(), this.pollMs)
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async state(sessionId: string): Promise<ChatAutomationState> {
    const root = await this.rootSessionId(sessionId)
    return {
      goal: await this.options.store.getGoal(root),
      loops: await this.options.store.listLoops(root),
    }
  }

  async createGoal(sessionId: string, input: CreateChatGoal): Promise<ChatGoal> {
    const root = await this.rootSessionId(sessionId)
    const now = this.now()
    const previous = await this.options.store.getGoal(root)
    const detail = await this.options.detail(root)
    const goal: ChatGoal = {
      id: crypto.randomUUID(),
      sessionId: root,
      objective: input.objective.trim(),
      status: "ACTIVE",
      turnCount: 0,
      maxTurns: input.maxTurns ?? DEFAULT_MAX_GOAL_TURNS,
      tokenBudget: input.tokenBudget ?? null,
      startedTokens: totalTokens(detail),
      usedTokens: 0,
      lastEvaluation: null,
      pendingEventKey: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.putGoal(goal)
    if (previous) await this.options.cancelQueuedEvents?.(root, "goal", previous.id)
    await this.queueGoalContinuation(goal, "The goal was created.")
    return (await this.options.store.getGoal(root)) ?? goal
  }

  async updateGoal(sessionId: string, input: UpdateChatGoal): Promise<ChatGoal | null> {
    const root = await this.rootSessionId(sessionId)
    const goal = await this.options.store.getGoal(root)
    if (!goal) {
      if (input.action === "CLEAR") return null
      throw new ProtocolError("not_found", "This chat has no goal")
    }
    if (input.action === "CLEAR") {
      await this.options.cancelQueuedEvents?.(root, "goal", goal.id)
      await this.options.store.removeGoal(root)
      return null
    }
    const updated: ChatGoal = {
      ...goal,
      status: input.action === "PAUSE" ? "PAUSED" : "ACTIVE",
      updatedAt: this.now(),
    }
    await this.options.store.putGoal(updated)
    if (input.action === "PAUSE") await this.options.cancelQueuedEvents?.(root, "goal", goal.id)
    if (input.action === "RESUME" && goal.status !== "ACTIVE") {
      await this.queueGoalContinuation(updated, "The user resumed this goal.")
    }
    return await this.options.store.getGoal(root)
  }

  /** The agent may finish its own goal, but cannot pause, resume, or clear it. */
  async finishGoal(sessionId: string, status: "COMPLETE" | "BLOCKED", reason: string): Promise<ChatGoal> {
    const root = await this.rootSessionId(sessionId)
    const goal = await this.options.store.getGoal(root)
    if (!goal) throw new ProtocolError("not_found", "This chat has no goal")
    const updated = { ...goal, status, lastEvaluation: reason.trim(), pendingEventKey: null, updatedAt: this.now() }
    await this.options.store.putGoal(updated)
    await this.noticeGoal(updated)
    return updated
  }

  async createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop> {
    const root = await this.rootSessionId(sessionId)
    const now = this.now()
    const existing = await this.options.store.listLoops(root)
    if (existing.filter((loop) => loop.status !== "COMPLETE").length >= MAX_SCHEDULED_TASKS) {
      throw new ProtocolError("invalid_request", `This chat already has ${MAX_SCHEDULED_TASKS} scheduled tasks`)
    }
    const usesDefaultPrompt = input.prompt === undefined
    const prompt = input.prompt ?? await this.defaultLoopPrompt()
    if (input.expiresAt !== undefined && input.expiresAt <= now) {
      throw new ProtocolError("invalid_request", "Scheduled task expiry must be in the future")
    }
    const expiresAt = input.expiresAt ?? (input.schedule === "ONCE" ? null : now + RECURRING_EXPIRY_MS)
    const id = crypto.randomUUID()
    const schedule = scheduleFields(input, now, id)
    if (expiresAt !== null && schedule.nextRunAt > expiresAt) schedule.nextRunAt = expiresAt
    const loop: ChatLoop = {
      id,
      sessionId: root,
      prompt: prompt.trim(),
      usesDefaultPrompt,
      ...schedule,
      status: "ACTIVE",
      lastRunAt: null,
      runCount: 0,
      maxRuns: input.maxRuns ?? null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.putLoop(loop)
    return loop
  }

  async rescheduleLoop(sessionId: string, loopId: string, intervalMs: number): Promise<ChatLoop> {
    const root = await this.rootSessionId(sessionId)
    const loop = (await this.options.store.listLoops(root)).find((entry) => entry.id === loopId)
    if (!loop) throw new ProtocolError("not_found", "No such loop in this chat")
    if (loop.schedule !== "DYNAMIC") {
      throw new ProtocolError("invalid_request", "Only a dynamic loop chooses its next interval")
    }
    if (loop.status !== "ACTIVE") throw new ProtocolError("invalid_request", "That dynamic loop is no longer active")
    if (intervalMs < 60_000 || intervalMs > 3_600_000) {
      throw new ProtocolError("invalid_request", "A dynamic loop interval must be between 1 and 60 minutes")
    }
    const now = this.now()
    const requestedRun = now + intervalMs
    const nextRunAt = loop.expiresAt !== null ? Math.min(requestedRun, loop.expiresAt) : requestedRun
    const updated = { ...loop, intervalMs, nextRunAt, updatedAt: now }
    await this.options.store.putLoop(updated)
    return updated
  }

  async cancelLoop(sessionId: string, loopId: string): Promise<void> {
    const root = await this.rootSessionId(sessionId)
    const loop = (await this.options.store.listLoops(root)).find((entry) => entry.id === loopId)
    if (!loop) throw new ProtocolError("not_found", "No such loop in this chat")
    await this.options.cancelQueuedEvents?.(root, "loop", loop.id)
    await this.options.store.removeLoop(loopId)
  }

  /** Called only after a root turn, its tools, retries, and compaction have settled. */
  async onTurnSettled(
    sessionId: string,
    event: { label: string | null; referenceId: string | null } | null = null,
  ): Promise<void> {
    if (event?.label === "loop" && event.referenceId) {
      const loop = (await this.options.store.listLoops(sessionId)).find((entry) => entry.id === event.referenceId)
      if (loop?.status === "COMPLETE") await this.options.store.removeLoop(loop.id)
    }
    const goal = await this.options.store.getGoal(sessionId)
    if (!goal || goal.status !== "ACTIVE") return
    const detail = await this.options.detail(sessionId)
    if (detail.session.parentSessionId || detail.session.queued > 0) return

    const usedTokens = Math.max(0, totalTokens(detail) - goal.startedTokens)
    if (goal.tokenBudget !== null && usedTokens >= goal.tokenBudget) {
      await this.finishGoal(sessionId, "BLOCKED", `Token budget reached (${usedTokens}/${goal.tokenBudget}).`)
      return
    }
    if (goal.turnCount >= goal.maxTurns) {
      await this.finishGoal(sessionId, "BLOCKED", `Continuation limit reached (${goal.maxTurns} turns).`)
      return
    }

    const model = await this.options.resolveModel(detail)
    let evaluation
    try {
      evaluation = await this.options.evaluator.evaluate({
        model: model.model,
        objective: goal.objective,
        turnCount: goal.turnCount,
        usedTokens,
        tokenBudget: goal.tokenBudget,
        evidence: detail.messages.slice(-EVIDENCE_MESSAGES).map((message) => ({
          role: message.role,
          text: message.text,
          isError: message.isError,
        })),
      })
    } catch (error) {
      this.options.onError(error)
      await this.finishGoal(sessionId, "BLOCKED", "The goal evaluator failed; resume the goal to try again.")
      return
    }

    const current = await this.options.store.getGoal(sessionId)
    if (!current || current.id !== goal.id || current.status !== "ACTIVE") return
    const evaluated = { ...current, usedTokens, lastEvaluation: evaluation.reason, updatedAt: this.now() }
    if (evaluation.verdict === "COMPLETE" || evaluation.verdict === "IMPOSSIBLE") {
      await this.options.store.putGoal({
        ...evaluated,
        status: evaluation.verdict === "COMPLETE" ? "COMPLETE" : "BLOCKED",
        pendingEventKey: null,
      })
      await this.noticeGoal({
        ...evaluated,
        status: evaluation.verdict === "COMPLETE" ? "COMPLETE" : "BLOCKED",
      })
      return
    }
    await this.options.store.putGoal(evaluated)
    await this.queueGoalContinuation(evaluated, evaluation.reason)
  }

  private async resumeGoals(): Promise<void> {
    for (const goal of await this.options.store.listActiveGoals()) {
      try {
        const detail = await this.options.detail(goal.sessionId)
        if (detail.session.running || detail.session.queued > 0) continue
        await this.queueGoalContinuation(goal, "Continue the active goal after server startup.")
      } catch (error) {
        this.options.onError(error)
      }
    }
  }

  private async queueGoalContinuation(goal: ChatGoal, reason: string): Promise<void> {
    if (goal.status !== "ACTIVE") return
    const turn = goal.pendingEventKey ? goal.turnCount : goal.turnCount + 1
    if (turn > goal.maxTurns) {
      await this.finishGoal(goal.sessionId, "BLOCKED", `Continuation limit reached (${goal.maxTurns} turns).`)
      return
    }
    const key = goal.pendingEventKey ?? `chat-goal:${goal.id}:${turn}`
    const pending = { ...goal, turnCount: turn, pendingEventKey: key, updatedAt: this.now() }
    await this.options.store.putGoal(pending)
    await this.options.enqueueEvent(goal.sessionId, {
      key,
      label: "goal",
      referenceId: goal.id,
      text: `Continuing goal: ${goal.objective}`,
      prompt: [
        "Continue the active goal autonomously.",
        `Objective: ${goal.objective}`,
        `Evaluator: ${reason}`,
        "Make concrete progress now. Do not ask the user unless progress genuinely requires their decision.",
      ].join("\n"),
    })
    const current = await this.options.store.getGoal(goal.sessionId)
    if (current?.id === goal.id && current.pendingEventKey === key) {
      await this.options.store.putGoal({ ...current, pendingEventKey: null, updatedAt: this.now() })
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.destroyed) return
    this.ticking = true
    try {
      const now = this.now()
      for (const loop of await this.options.store.listDueLoops(now)) {
        try {
          await this.fireLoop(loop, now)
        } catch (error) {
          this.options.onError(error)
        }
      }
    } catch (error) {
      this.options.onError(error)
    } finally {
      this.ticking = false
    }
  }

  private async fireLoop(loop: ChatLoop, now: number): Promise<void> {
    const scheduledAt = loop.nextRunAt
    const prompt = loop.usesDefaultPrompt ? await this.defaultLoopPrompt() : loop.prompt
    const runCount = loop.runCount + 1
    const expired = loop.expiresAt !== null && loop.expiresAt <= now
    const complete = loop.schedule === "ONCE" || expired || (loop.maxRuns !== null && runCount >= loop.maxRuns)
    await this.options.enqueueEvent(loop.sessionId, {
      key: `chat-loop:${loop.id}:${scheduledAt}`,
      label: "loop",
      referenceId: loop.id,
      text: `Scheduled check: ${prompt}`,
      prompt: [
        "Run this scheduled task now.",
        `Task: ${prompt}`,
        ...(loop.schedule === "DYNAMIC" && !complete ? [
          `This is dynamic loop ${loop.id}. After observing the result, call reschedule_loop with a delay from 1 to 60 minutes and briefly explain why that cadence fits.`,
        ] : []),
        "Refresh any current data the task depends on.",
      ].join("\n"),
    })
    const nextRunAt = complete ? scheduledAt : nextLoopRun(loop, now)
    await this.options.store.putLoop({
      ...loop,
      status: complete ? "COMPLETE" : "ACTIVE",
      nextRunAt,
      lastRunAt: now,
      runCount,
      updatedAt: now,
    })
  }

  private async defaultLoopPrompt(): Promise<string> {
    return await this.options.defaultLoopPrompt?.() ?? DEFAULT_LOOP_PROMPT
  }

  private async rootSessionId(sessionId: string): Promise<string> {
    let detail = await this.options.detail(sessionId)
    const seen = new Set<string>()
    while (detail.session.parentSessionId) {
      if (seen.has(detail.session.id)) throw new Error("Chat session parent cycle")
      seen.add(detail.session.id)
      detail = await this.options.detail(detail.session.parentSessionId)
    }
    return detail.session.id
  }

  private async noticeGoal(goal: ChatGoal): Promise<void> {
    if (!this.options.notify) return
    try {
      await this.options.notify({
        sessionId: goal.sessionId,
        title: goal.status === "COMPLETE" ? "Goal complete" : "Goal needs attention",
        message: goal.lastEvaluation ?? goal.objective,
      })
    } catch (error) {
      this.options.onError(error)
    }
  }
}

function scheduleFields(input: CreateChatLoop, now: number, id: string): {
  schedule: "INTERVAL"
  intervalMs: number
  cronExpression: null
  nextRunAt: number
} | {
  schedule: "DYNAMIC"
  intervalMs: number
  cronExpression: null
  nextRunAt: number
} | {
  schedule: "CRON"
  intervalMs: null
  cronExpression: string
  nextRunAt: number
} | {
  schedule: "ONCE"
  intervalMs: null
  cronExpression: null
  nextRunAt: number
} {
  switch (input.schedule) {
    case "INTERVAL":
      return {
        schedule: input.schedule,
        intervalMs: input.intervalMs,
        cronExpression: null,
        nextRunAt: now + input.intervalMs + recurringJitter(id, input.intervalMs),
      }
    case "DYNAMIC": {
      const intervalMs = input.initialDelayMs ?? DEFAULT_DYNAMIC_DELAY_MS
      return { schedule: input.schedule, intervalMs, cronExpression: null, nextRunAt: now + intervalMs }
    }
    case "CRON": {
      if (!isValidCronExpression(input.cronExpression)) {
        throw new ProtocolError("invalid_request", "Invalid five-field cron expression")
      }
      const nextRunAt = nextCronOccurrence(input.cronExpression, now)
      if (nextRunAt === null) throw new ProtocolError("invalid_request", "Cron expression has no future occurrence")
      return {
        schedule: input.schedule,
        intervalMs: null,
        cronExpression: input.cronExpression,
        nextRunAt: nextRunAt + cronJitter(id, input.cronExpression, nextRunAt),
      }
    }
    case "ONCE":
      if (input.runAt <= now) throw new ProtocolError("invalid_request", "One-time task must be scheduled in the future")
      return {
        schedule: input.schedule,
        intervalMs: null,
        cronExpression: null,
        nextRunAt: oneTimeRunAt(id, input.runAt, now),
      }
  }
}

function nextLoopRun(loop: ChatLoop, now: number): number {
  let next: number
  if (loop.schedule === "CRON") {
    const base = nextCronOccurrence(loop.cronExpression, now) ?? now + RECURRING_EXPIRY_MS
    next = base + cronJitter(loop.id, loop.cronExpression, base)
  } else if (loop.schedule === "INTERVAL" || loop.schedule === "DYNAMIC") {
    const elapsed = Math.max(0, now - loop.nextRunAt)
    const periods = Math.floor(elapsed / loop.intervalMs) + 1
    next = loop.nextRunAt + periods * loop.intervalMs
  } else {
    return loop.nextRunAt
  }
  return loop.expiresAt !== null && next > loop.expiresAt ? loop.expiresAt : next
}

function cronJitter(id: string, expression: string, occurrence: number): number {
  const following = nextCronOccurrence(expression, occurrence)
  const cadence = following === null ? 60 * 60_000 : following - occurrence
  return recurringJitter(id, cadence)
}

function recurringJitter(id: string, cadenceMs: number): number {
  const maximum = Math.floor(Math.min(30 * 60_000, cadenceMs < 60 * 60_000 ? cadenceMs / 2 : 30 * 60_000))
  return deterministicOffset(id, maximum)
}

function oneTimeRunAt(id: string, requested: number, now: number): number {
  const date = new Date(requested)
  if ((date.getMinutes() !== 0 && date.getMinutes() !== 30) || date.getSeconds() !== 0) return requested
  return Math.max(now + 1, requested - deterministicOffset(id, 90_000))
}

function deterministicOffset(id: string, maximum: number): number {
  let hash = 2_166_136_261
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) % (maximum + 1)
}

function totalTokens(detail: ChatSessionDetail): number {
  return detail.messages.reduce((total, message) => total + (message.usage?.totalTokens ?? 0), 0)
}
