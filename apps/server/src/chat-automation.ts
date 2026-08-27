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
import type { ChatNotification } from "@trbot/chat/notification.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatTurnModel } from "@trbot/ai/chat.ts"

const LOOP_POLL_MS = 15_000
const GOAL_FAILURE_INITIAL_DELAY_MS = 60_000
const GOAL_FAILURE_LIMIT = 5
const EVIDENCE_MESSAGES = 16
const MAX_SCHEDULED_TASKS = 50
const RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60_000
const DEFAULT_DYNAMIC_DELAY_MS = 60_000
const CADENCE_CONFLICT_REASON = "Paused because this chat also has active scheduled tasks. Cancel them before resuming the goal."

export const DEFAULT_LOOP_PROMPT = [
  "Continue unfinished work from this conversation.",
  "Review any active position, monitor, or analysis the user already asked you to tend.",
  "If nothing needs action, report that briefly without starting a new initiative.",
].join(" ")

export interface ChatAutomationControllerOptions {
  store: ChatAutomationStore
  detail: (sessionId: string) => Promise<ChatSessionDetail>
  enqueueEvent: (sessionId: string, event: ChatApplicationEvent) => Promise<boolean>
  resumeQueue?: (sessionId: string) => void
  cancelQueuedEvents?: (sessionId: string, label: string, referenceId: string) => Promise<void>
  resolveModel: (detail: ChatSessionDetail) => Promise<ChatTurnModel>
  evaluator: ChatGoalEvaluatorRunner
  defaultLoopPrompt?: () => Promise<string | null>
  notify?: (input: { sessionId: string; title: string; message: string }) => Promise<ChatNotification>
  onError: (cause: unknown) => void
  now?: () => number
  pollMs?: number
}

/** Owns durable goal continuation and wall-clock chat wake-ups. */
export class ChatAutomationController {
  private readonly now: () => number
  private readonly pollMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly automationMutations = new Map<string, Promise<void>>()
  private ticking = false
  private destroyed = false

  constructor(private readonly options: ChatAutomationControllerOptions) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? LOOP_POLL_MS
  }

  /** Reconciles persisted automation state before the chat queue begins draining. */
  async prepare(): Promise<void> {
    await this.reconcileCadenceConflicts()
  }

  async start(): Promise<void> {
    await this.prepare()
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
    return await this.mutateAutomation(root, async () => ({
      goal: await this.options.store.getGoal(root),
      loops: await this.options.store.listLoops(root),
    }))
  }

  async createGoal(sessionId: string, input: CreateChatGoal): Promise<ChatGoal> {
    const root = await this.rootSessionId(sessionId)
    return await this.mutateAutomation(root, async () => {
      const loops = await this.options.store.listLoops(root)
      if (loops.some((loop) => loop.status === "ACTIVE")) {
        throw new ProtocolError(
          "invalid_request",
          "Cancel this chat's active scheduled tasks before starting a goal; combining them duplicates autonomous work",
        )
      }
      const now = this.now()
      const previous = await this.options.store.getGoal(root)
      const detail = await this.options.detail(root)
      const goal: ChatGoal = {
        id: crypto.randomUUID(),
        sessionId: root,
        objective: input.objective.trim(),
        status: "ACTIVE",
        turnCount: 0,
        maxTurns: input.maxTurns ?? null,
        tokenBudget: input.tokenBudget ?? null,
        startedTokens: totalTokens(detail),
        usedTokens: 0,
        lastEvaluation: null,
        pendingEventKey: null,
        failureCount: 0,
        retryAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await this.options.store.putGoal(goal)
      if (previous) await this.options.cancelQueuedEvents?.(root, "goal", previous.id)
      await this.queueGoalContinuation(goal, "The goal was created.")
      return (await this.options.store.getGoal(root)) ?? goal
    })
  }

  async updateGoal(sessionId: string, input: UpdateChatGoal): Promise<ChatGoal | null> {
    const root = await this.rootSessionId(sessionId)
    return await this.mutateAutomation(root, async () => {
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
      if (input.action === "RESUME") {
        const loops = await this.options.store.listLoops(root)
        if (loops.some((loop) => loop.status === "ACTIVE")) {
          throw new ProtocolError(
            "invalid_request",
            "Cancel this chat's active scheduled tasks before resuming the goal; combining them duplicates autonomous work",
          )
        }
      }
      const updated: ChatGoal = {
        ...goal,
        status: input.action === "PAUSE" ? "PAUSED" : "ACTIVE",
        failureCount: input.action === "RESUME" ? 0 : goal.failureCount,
        retryAt: null,
        updatedAt: this.now(),
      }
      await this.options.store.putGoal(updated)
      if (input.action === "PAUSE") await this.options.cancelQueuedEvents?.(root, "goal", goal.id)
      if (input.action === "RESUME" && (goal.status !== "ACTIVE" || goal.retryAt !== null)) {
        await this.queueGoalContinuation(updated, "The user resumed this goal.")
      }
      return await this.options.store.getGoal(root)
    })
  }

  /** The agent may finish its own goal, but cannot pause, resume, or clear it. */
  async finishGoal(sessionId: string, status: "COMPLETE" | "BLOCKED", reason: string): Promise<ChatGoal> {
    return (await this.finishGoalWithNotice(sessionId, status, reason)).goal
  }

  /** The tool path also journals the durable notice emitted by goal completion. */
  async finishGoalWithNotice(
    sessionId: string,
    status: "COMPLETE" | "BLOCKED",
    reason: string,
    expectedGoalId?: string | null,
  ): Promise<{ goal: ChatGoal; notification: ChatNotification | null }> {
    const root = await this.rootSessionId(sessionId)
    return await this.mutateAutomation(root, () => this.finishGoalNow(root, status, reason, expectedGoalId))
  }

  private async finishGoalNow(
    sessionId: string,
    status: "COMPLETE" | "BLOCKED",
    reason: string,
    expectedGoalId?: string | null,
  ): Promise<{ goal: ChatGoal; notification: ChatNotification | null }> {
    const goal = await this.options.store.getGoal(sessionId)
    if (!goal) throw new ProtocolError("not_found", "This chat has no goal")
    if (expectedGoalId !== undefined && (goal.id !== expectedGoalId || goal.status !== "ACTIVE")) {
      throw new ProtocolError("invalid_request", "The goal changed before this turn could finish it")
    }
    const updated = {
      ...goal,
      status,
      lastEvaluation: reason.trim(),
      pendingEventKey: null,
      retryAt: null,
      updatedAt: this.now(),
    }
    await this.options.store.putGoal(updated)
    const notification = await this.noticeGoal(updated)
    return { goal: updated, notification }
  }

  async createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop> {
    const root = await this.rootSessionId(sessionId)
    return await this.mutateAutomation(root, async () => {
      const goal = await this.options.store.getGoal(root)
      if (goal?.status === "ACTIVE") {
        throw new ProtocolError(
          "invalid_request",
          "Pause or clear this chat's active goal before scheduling a task; combining them duplicates autonomous work",
        )
      }
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
    })
  }

  async rescheduleLoop(sessionId: string, loopId: string, intervalMs: number): Promise<ChatLoop> {
    const root = await this.rootSessionId(sessionId)
    return await this.mutateAutomation(root, async () => {
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
    })
  }

  async cancelLoop(sessionId: string, loopId: string): Promise<void> {
    const root = await this.rootSessionId(sessionId)
    await this.mutateAutomation(root, async () => {
      const loop = (await this.options.store.listLoops(root)).find((entry) => entry.id === loopId)
      if (!loop) throw new ProtocolError("not_found", "No such loop in this chat")
      await this.options.cancelQueuedEvents?.(root, "loop", loop.id)
      await this.options.store.removeLoop(loopId)
    })
  }

  /** Restores an exact goal snapshot after a conversation rewind. */
  async restoreGoal(sessionId: string, goal: ChatGoal | null): Promise<void> {
    const root = await this.rootSessionId(sessionId)
    await this.mutateAutomation(root, async () => {
      if (goal && goal.sessionId !== root) throw new Error("The restored goal belongs to another chat")
      if (goal?.status === "ACTIVE") {
        const loops = await this.options.store.listLoops(root)
        if (loops.some((loop) => loop.status === "ACTIVE")) {
          throw new ProtocolError("invalid_request", "Cannot restore an active goal while this chat has active scheduled tasks")
        }
      }
      const current = await this.options.store.getGoal(root)
      if (current) await this.options.cancelQueuedEvents?.(root, "goal", current.id)
      if (goal) await this.options.store.putGoal(goal)
      else await this.options.store.removeGoal(root)
    })
  }

  /** Restores or removes one exact scheduled-task snapshot after rewind. */
  async restoreLoop(sessionId: string, loopId: string, loop: ChatLoop | null): Promise<void> {
    const root = await this.rootSessionId(sessionId)
    await this.mutateAutomation(root, async () => {
      if (loop && loop.sessionId !== root) throw new Error("The restored scheduled task belongs to another chat")
      if (loop?.status === "ACTIVE" && (await this.options.store.getGoal(root))?.status === "ACTIVE") {
        throw new ProtocolError("invalid_request", "Cannot restore an active scheduled task while this chat has an active goal")
      }
      const current = (await this.options.store.listLoops(root)).find((entry) => entry.id === loopId)
      if (current) await this.options.cancelQueuedEvents?.(root, "loop", loopId)
      if (loop) await this.options.store.putLoop(loop)
      else await this.options.store.removeLoop(loopId)
    })
  }

  /** Called only after a root turn, its tools, retries, and compaction have settled. */
  async onTurnSettled(
    sessionId: string,
    event: { label: string | null; referenceId: string | null } | null = null,
  ): Promise<void> {
    await this.mutateAutomation(sessionId, () => this.settleTurn(sessionId, event))
  }

  private async settleTurn(
    sessionId: string,
    event: { label: string | null; referenceId: string | null } | null,
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
      await this.finishGoalNow(sessionId, "BLOCKED", `Token budget reached (${usedTokens}/${goal.tokenBudget}).`)
      return
    }
    if (goal.maxTurns !== null && goal.turnCount >= goal.maxTurns) {
      await this.finishGoalNow(sessionId, "BLOCKED", turnLimitReason(goal.maxTurns))
      return
    }
    let model
    try {
      model = await this.options.resolveModel(detail)
    } catch (error) {
      await this.recordGoalFailureNow(goal)
      this.options.onError(error)
      return
    }
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
      await this.finishGoalNow(sessionId, "BLOCKED", "The goal evaluator failed; resume the goal to try again.")
      this.options.onError(error)
      return
    }

    const current = await this.options.store.getGoal(sessionId)
    if (!current || current.id !== goal.id || current.status !== "ACTIVE") return
    const evaluated = {
      ...current,
      usedTokens,
      lastEvaluation: evaluation.reason,
      failureCount: 0,
      retryAt: null,
      updatedAt: this.now(),
    }
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

  /** Replaces a failed goal wake-up so an active goal cannot become stranded. */
  async onTurnFailed(
    sessionId: string,
    event: { label: string | null; referenceId: string | null },
  ): Promise<void> {
    if (event.label !== "goal" || !event.referenceId) return
    await this.mutateAutomation(sessionId, async () => {
      const goal = await this.options.store.getGoal(sessionId)
      if (!goal || goal.id !== event.referenceId || goal.status !== "ACTIVE") return
      await this.recordGoalFailureNow(goal)
    })
  }

  private async recordGoalFailureNow(goal: ChatGoal): Promise<void> {
    const failureCount = goal.failureCount + 1
    if (failureCount >= GOAL_FAILURE_LIMIT) {
      await this.options.store.putGoal({
        ...goal,
        failureCount,
        retryAt: null,
        pendingEventKey: null,
        updatedAt: this.now(),
      })
      await this.finishGoalNow(
        goal.sessionId,
        "BLOCKED",
        `Agent wake-up failed ${GOAL_FAILURE_LIMIT} times; resume the goal to try again.`,
      )
      return
    }
    const retryAt = this.now() + goalFailureDelay(failureCount)
    await this.options.store.putGoal({
      ...goal,
      failureCount,
      retryAt,
      pendingEventKey: null,
      lastEvaluation: "Agent wake-up failed; retrying automatically.",
      updatedAt: this.now(),
    })
  }

  private async resumeGoals(now = this.now()): Promise<void> {
    for (const goal of await this.options.store.listActiveGoals()) {
      try {
        await this.mutateAutomation(goal.sessionId, async () => {
          const current = await this.options.store.getGoal(goal.sessionId)
          if (!current || current.id !== goal.id || current.status !== "ACTIVE") return
          const detail = await this.options.detail(goal.sessionId)
          if (detail.session.running) return
          if (detail.session.queued > 0) {
            this.options.resumeQueue?.(goal.sessionId)
            return
          }
          if (current.retryAt !== null && current.retryAt > now) return
          await this.queueGoalContinuation(
            current,
            current.retryAt === null
              ? "Continue the active goal after server startup."
              : "Retry the active goal after its previous wake-up failed.",
          )
        })
      } catch (error) {
        this.options.onError(error)
      }
    }
  }

  private async queueGoalContinuation(goal: ChatGoal, reason: string): Promise<void> {
    if (goal.status !== "ACTIVE") return
    const turn = goal.pendingEventKey ? goal.turnCount : goal.turnCount + 1
    if (goal.maxTurns !== null && turn > goal.maxTurns) {
      await this.finishGoalNow(goal.sessionId, "BLOCKED", turnLimitReason(goal.maxTurns))
      return
    }
    const key = goal.pendingEventKey ?? `chat-goal:${goal.id}:${turn}`
    const pending = { ...goal, turnCount: turn, pendingEventKey: key, retryAt: null, updatedAt: this.now() }
    await this.options.store.putGoal(pending)
    const enqueued = await this.options.enqueueEvent(goal.sessionId, {
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
      const handedOff = { ...current, pendingEventKey: null, updatedAt: this.now() }
      await this.options.store.putGoal(handedOff)
      if (!enqueued) {
        const detail = await this.options.detail(goal.sessionId)
        if (!detail.session.running && detail.session.queued === 0) {
          await this.queueGoalContinuation(handedOff, reason)
        }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.destroyed) return
    this.ticking = true
    try {
      const now = this.now()
      for (const loop of await this.options.store.listDueLoops(now)) {
        try {
          await this.mutateAutomation(loop.sessionId, async () => {
            const current = (await this.options.store.listLoops(loop.sessionId))
              .find((entry) => entry.id === loop.id)
            if (!current || current.status !== "ACTIVE" || current.nextRunAt > now) return
            await this.pauseGoalForCadenceConflict(loop.sessionId)
            await this.fireLoop(current, now)
          })
        } catch (error) {
          this.options.onError(error)
        }
      }
      await this.resumeGoals(now)
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

  private async reconcileCadenceConflicts(): Promise<void> {
    for (const goal of await this.options.store.listActiveGoals()) {
      await this.mutateAutomation(goal.sessionId, () => this.pauseGoalForCadenceConflict(goal.sessionId))
    }
  }

  /** Active scheduled work wins over an older conflicting goal because it has an explicit cadence. */
  private async pauseGoalForCadenceConflict(sessionId: string): Promise<void> {
    const goal = await this.options.store.getGoal(sessionId)
    if (!goal || goal.status !== "ACTIVE") return
    const loops = await this.options.store.listLoops(sessionId)
    if (!loops.some((loop) => loop.status === "ACTIVE")) return
    const updated: ChatGoal = {
      ...goal,
      status: "PAUSED",
      lastEvaluation: CADENCE_CONFLICT_REASON,
      pendingEventKey: null,
      retryAt: null,
      updatedAt: this.now(),
    }
    await this.options.store.putGoal(updated)
    await this.options.cancelQueuedEvents?.(sessionId, "goal", goal.id)
    await this.noticeGoal(updated)
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

  /** Serializes automation transitions so goal and schedule decisions cannot race each other. */
  private async mutateAutomation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.automationMutations.get(sessionId) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => { release = resolve })
    this.automationMutations.set(sessionId, current)
    await previous
    try {
      return await mutation()
    } finally {
      release()
      if (this.automationMutations.get(sessionId) === current) this.automationMutations.delete(sessionId)
    }
  }

  private async noticeGoal(goal: ChatGoal): Promise<ChatNotification | null> {
    if (!this.options.notify) return null
    try {
      return await this.options.notify({
        sessionId: goal.sessionId,
        title: goal.status === "COMPLETE" ? "Goal complete" : "Goal needs attention",
        message: goal.lastEvaluation ?? goal.objective,
      })
    } catch (error) {
      this.options.onError(error)
      return null
    }
  }
}

function goalFailureDelay(failureCount: number): number {
  return GOAL_FAILURE_INITIAL_DELAY_MS * 2 ** (failureCount - 1)
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

function turnLimitReason(maxTurns: number): string {
  return `Continuation limit reached (${maxTurns} turn${maxTurns === 1 ? "" : "s"}).`
}
