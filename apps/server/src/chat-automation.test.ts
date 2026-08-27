import { afterEach, expect, test } from "bun:test"
import type { ChatGoalEvaluation } from "@trbot/chat/automation.ts"
import type { ChatApplicationEvent, ChatMessage, ChatSessionDetail } from "@trbot/chat/session.ts"
import { DrizzleChatAutomationStore } from "@trbot/db/chat-automation-store.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import { chatSessions } from "@trbot/db/schema.ts"
import { ChatAutomationController } from "./chat-automation.ts"
import { testModel } from "@trbot/ai/model.test-fixture.ts"

const model = testModel("model")

let connection: DatabaseConnection | null = null
let controller: ChatAutomationController | null = null

afterEach(() => {
  controller?.destroy()
  controller = null
  connection?.close()
  connection = null
})

async function harness(options: {
  now?: () => number
  evaluations?: ChatGoalEvaluation[]
  defaultLoopPrompt?: () => Promise<string | null>
  enqueueResults?: boolean[]
  resolveModel?: () => Promise<void>
  beforeEnqueue?: (event: ChatApplicationEvent) => Promise<void>
} = {}) {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "Test",
    model: "model",
    provider: "provider",
    createdAt: 1_000,
    updatedAt: 1_000,
  })
  const messages: ChatMessage[] = []
  const events: ChatApplicationEvent[] = []
  const notices: string[] = []
  const cancelledLabels: string[] = []
  const resumedQueues: string[] = []
  let queued = 0
  const enqueueResults = [...(options.enqueueResults ?? [])]
  const evaluations = [...(options.evaluations ?? [])]
  const detail = (): ChatSessionDetail => ({
    session: {
      id: "chat-1",
      title: "Test",
      parentSessionId: null,
      parentPromptMessageId: null,
      parentToolCallId: null,
      agent: null,
      model: "model",
      provider: "provider",
      reasoning: "high",
      createdAt: 1_000,
      updatedAt: 1_000,
      messageCount: messages.length,
      queued,
      running: false,
    },
    messages,
    partial: null,
  })
  const store = new DrizzleChatAutomationStore(connection.db)
  controller = new ChatAutomationController({
    store,
    detail: async () => detail(),
    enqueueEvent: async (_sessionId, event) => {
      await options.beforeEnqueue?.(event)
      const enqueued = enqueueResults.shift() ?? true
      if (enqueued) {
        events.push(event)
        queued += 1
      }
      return enqueued
    },
    resumeQueue: (sessionId) => { resumedQueues.push(sessionId) },
    cancelQueuedEvents: async (_sessionId, label) => {
      cancelledLabels.push(label)
      queued = 0
    },
    resolveModel: async () => {
      await options.resolveModel?.()
      return { model }
    },
    evaluator: {
      evaluate: async () => evaluations.shift() ?? { verdict: "COMPLETE", reason: "Done." },
    },
    defaultLoopPrompt: options.defaultLoopPrompt,
    notify: async ({ sessionId, title, message }) => {
      notices.push(message)
      return {
        id: crypto.randomUUID(),
        sessionId,
        title,
        message,
        urgency: "IMPORTANT",
        createdAt: options.now?.() ?? Date.now(),
      }
    },
    onError: (error) => { throw error },
    now: options.now,
    pollMs: 3_600_000,
  })
  return {
    automation: controller,
    store,
    messages,
    events,
    notices,
    cancelledLabels,
    resumedQueues,
    settleEvents: () => { queued = 0 },
    setQueued: (count: number) => { queued = count },
  }
}

test("a goal starts immediately and a separate evaluator controls continuation", async () => {
  const { automation, messages, events, notices, settleEvents } = await harness({
    evaluations: [
      { verdict: "CONTINUE", reason: "One verification remains." },
      { verdict: "COMPLETE", reason: "The result is verified." },
    ],
  })
  const goal = await automation.createGoal("chat-1", { objective: "Verify the setup" })
  expect(goal.turnCount).toBe(1)
  expect(goal.maxTurns).toBeNull()
  expect(goal.tokenBudget).toBeNull()
  expect(events[0]?.label).toBe("goal")

  settleEvents()
  messages.push(reply(100))
  await automation.onTurnSettled("chat-1")
  expect(events).toHaveLength(2)
  expect((await automation.state("chat-1")).goal?.lastEvaluation).toBe("One verification remains.")

  settleEvents()
  messages.push(reply(200))
  await automation.onTurnSettled("chat-1")
  const finished = (await automation.state("chat-1")).goal
  expect(finished?.status).toBe("COMPLETE")
  expect(finished?.usedTokens).toBe(300)
  expect(notices).toEqual(["The result is verified."])
})

test("a failed goal wake-up retries with durable backoff", async () => {
  let now = 1_000
  const { automation, events, settleEvents } = await harness({ now: () => now })
  const goal = await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  settleEvents()

  await automation.onTurnFailed("chat-1", { label: "goal", referenceId: goal.id })

  expect(events).toHaveLength(1)
  const waiting = (await automation.state("chat-1")).goal
  expect(waiting).toMatchObject({ status: "ACTIVE", failureCount: 1, retryAt: 61_000 })

  now = waiting?.retryAt ?? now
  await automation.start()

  expect(events).toHaveLength(2)
  expect(events.map((event) => event.key)).toEqual([
    `chat-goal:${goal.id}:1`,
    `chat-goal:${goal.id}:2`,
  ])
  expect(events[1]?.prompt).toContain("previous wake-up failed")
  expect((await automation.state("chat-1")).goal?.turnCount).toBe(2)
})

test("blocks a goal after five consecutive wake-up failures", async () => {
  const { automation, settleEvents, notices } = await harness({ now: () => 1_000 })
  const goal = await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  settleEvents()

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await automation.onTurnFailed("chat-1", { label: "goal", referenceId: goal.id })
  }
  expect((await automation.state("chat-1")).goal).toMatchObject({
    status: "ACTIVE",
    failureCount: 4,
    retryAt: 481_000,
  })

  await automation.onTurnFailed("chat-1", { label: "goal", referenceId: goal.id })

  expect((await automation.state("chat-1")).goal).toMatchObject({
    status: "BLOCKED",
    failureCount: 5,
    retryAt: null,
    lastEvaluation: "Agent wake-up failed 5 times; resume the goal to try again.",
  })
  expect(notices).toEqual(["Agent wake-up failed 5 times; resume the goal to try again."])
})

test("advances past a stale pending event key after restart", async () => {
  const { automation, store, events, settleEvents } = await harness({
    now: () => 1_000,
    enqueueResults: [true, false, true],
  })
  const goal = await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  settleEvents()
  const current = await store.getGoal("chat-1")
  expect(current).not.toBeNull()
  await store.putGoal({ ...current!, pendingEventKey: events[0]!.key })

  await automation.start()

  expect(events.map((event) => event.key)).toEqual([
    `chat-goal:${goal.id}:1`,
    `chat-goal:${goal.id}:2`,
  ])
  expect((await automation.state("chat-1")).goal).toMatchObject({ turnCount: 2, pendingEventKey: null })
})

test("repairs an idle active goal after queued work fails", async () => {
  let now = 1_000
  const { automation, events, settleEvents, setQueued } = await harness({ now: () => now })
  const goal = await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  settleEvents()
  setQueued(1)

  await automation.onTurnSettled("chat-1", { label: "goal", referenceId: goal.id })
  expect(events).toHaveLength(1)

  setQueued(0)
  now += 15_000
  await automation.start()

  expect(events.map((event) => event.key)).toEqual([
    `chat-goal:${goal.id}:1`,
    `chat-goal:${goal.id}:2`,
  ])
})

test("polling resumes queued work that was waiting for provider reconnection", async () => {
  const { automation, resumedQueues, setQueued } = await harness({ now: () => 1_000 })
  await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  setQueued(2)

  await automation.start()

  expect(resumedQueues).toContain("chat-1")
})

test("backs off when goal evaluation cannot resolve its model", async () => {
  const { automation, messages, settleEvents } = await harness({
    now: () => 1_000,
    resolveModel: async () => { throw new Error("provider disconnected") },
  })
  const goal = await automation.createGoal("chat-1", { objective: "Keep monitoring" })
  settleEvents()
  messages.push(reply(100))

  await expect(automation.onTurnSettled("chat-1", { label: "goal", referenceId: goal.id })).rejects.toThrow(
    "provider disconnected",
  )

  expect((await automation.state("chat-1")).goal).toMatchObject({
    status: "ACTIVE",
    failureCount: 1,
    retryAt: 61_000,
  })
})

test("a stale turn cannot finish a replaced or paused goal", async () => {
  const { automation } = await harness({ now: () => 1_000 })
  const original = await automation.createGoal("chat-1", { objective: "Original" })
  const replacement = await automation.createGoal("chat-1", { objective: "Replacement" })

  await expect(automation.finishGoalWithNotice(
    "chat-1",
    "COMPLETE",
    "Old work finished.",
    original.id,
  )).rejects.toThrow("goal changed")
  expect((await automation.state("chat-1")).goal).toMatchObject({ id: replacement.id, status: "ACTIVE" })

  await automation.updateGoal("chat-1", { action: "PAUSE" })
  await expect(automation.finishGoalWithNotice(
    "chat-1",
    "COMPLETE",
    "Late completion.",
    replacement.id,
  )).rejects.toThrow("goal changed")
  expect((await automation.state("chat-1")).goal).toMatchObject({ id: replacement.id, status: "PAUSED" })
})

test("enforces an explicitly requested goal turn limit", async () => {
  const { automation, messages, events, settleEvents } = await harness()
  await automation.createGoal("chat-1", { objective: "Try once", maxTurns: 1 })

  settleEvents()
  messages.push(reply(100))
  await automation.onTurnSettled("chat-1")

  const goal = (await automation.state("chat-1")).goal
  expect(goal?.status).toBe("BLOCKED")
  expect(goal?.lastEvaluation).toBe("Continuation limit reached (1 turn).")
  expect(events).toHaveLength(1)
})

test("a due loop wakes its chat once and completes at max runs", async () => {
  let now = 1_000
  const { automation, events } = await harness({ now: () => now })
  const loop = await automation.createLoop("chat-1", {
    schedule: "INTERVAL",
    prompt: "Refresh positions",
    intervalMs: 60_000,
    maxRuns: 1,
  })
  now = loop.nextRunAt
  await automation.start()

  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ label: "loop", text: "Scheduled check: Refresh positions" })
  expect((await automation.state("chat-1")).loops[0]?.status).toBe("COMPLETE")
})

test("supports dynamic, cron, one-time, and default-maintenance schedules", async () => {
  let now = new Date(2026, 0, 5, 8, 58).getTime()
  let defaultPrompt = "Custom maintenance"
  const { automation, events } = await harness({
    now: () => now,
    defaultLoopPrompt: async () => defaultPrompt,
  })

  const dynamic = await automation.createLoop("chat-1", { schedule: "DYNAMIC", prompt: "Check CI" })
  expect(dynamic.intervalMs).toBe(60_000)
  expect(dynamic.expiresAt).toBe(now + 7 * 24 * 60 * 60_000)
  expect((await automation.rescheduleLoop("chat-1", dynamic.id, 30 * 60_000)).nextRunAt).toBe(now + 30 * 60_000)

  const cron = await automation.createLoop("chat-1", {
    schedule: "CRON",
    cronExpression: "0 9 * * 1-5",
    prompt: "Opening check",
  })
  expect(cron.nextRunAt).toBeGreaterThanOrEqual(new Date(2026, 0, 5, 9, 0).getTime())
  expect(cron.nextRunAt).toBeLessThanOrEqual(new Date(2026, 0, 5, 9, 30).getTime())

  const once = await automation.createLoop("chat-1", { schedule: "ONCE", runAt: now + 60_000 })
  expect(once.prompt).toBe("Custom maintenance")
  defaultPrompt = "Updated maintenance"
  now = once.nextRunAt
  await automation.start()
  expect(events.some((event) => event.referenceId === once.id)).toBe(true)
  expect(events.find((event) => event.referenceId === once.id)?.text).toBe("Scheduled check: Updated maintenance")
  expect((await automation.state("chat-1")).loops.find((loop) => loop.id === once.id)?.status).toBe("COMPLETE")
  await automation.onTurnSettled("chat-1", { label: "loop", referenceId: once.id })
  expect((await automation.state("chat-1")).loops.some((loop) => loop.id === once.id)).toBe(false)
})

test("prevents active goals and scheduled tasks from driving the same chat", async () => {
  const { automation } = await harness({ now: () => 1_000 })
  await automation.createGoal("chat-1", { objective: "Finish the rebalance" })

  await expect(automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "Check the portfolio",
  })).rejects.toThrow("combining them duplicates autonomous work")

  await automation.updateGoal("chat-1", { action: "PAUSE" })
  const loop = await automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "Check the portfolio until session close",
  })
  await expect(automation.updateGoal("chat-1", { action: "RESUME" })).rejects.toThrow(
    "combining them duplicates autonomous work",
  )
  await expect(automation.createGoal("chat-1", { objective: "Replace the paused goal" })).rejects.toThrow(
    "combining them duplicates autonomous work",
  )

  await automation.cancelLoop("chat-1", loop.id)
  expect((await automation.updateGoal("chat-1", { action: "RESUME" }))?.status).toBe("ACTIVE")
})

test("serializes a due loop with cancellation and goal creation", async () => {
  let now = 1_000
  const loopStarted = Promise.withResolvers<void>()
  const releaseLoop = Promise.withResolvers<void>()
  const { automation } = await harness({
    now: () => now,
    beforeEnqueue: async (event) => {
      if (event.label !== "loop") return
      loopStarted.resolve()
      await releaseLoop.promise
    },
  })
  const loop = await automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "Check the portfolio",
  })
  now = loop.nextRunAt

  const starting = automation.start()
  await loopStarted.promise
  const cancelling = automation.cancelLoop("chat-1", loop.id)
  const creatingGoal = automation.createGoal("chat-1", { objective: "Finish the rebalance" })
  releaseLoop.resolve()
  await Promise.all([starting, cancelling, creatingGoal])

  const state = await automation.state("chat-1")
  expect(state.loops).toEqual([])
  expect(state.goal?.status).toBe("ACTIVE")
})

test("rejects rewind snapshots that restore conflicting active cadences", async () => {
  const { automation } = await harness({ now: () => 1_000 })
  const goal = await automation.createGoal("chat-1", { objective: "Finish the rebalance" })
  await automation.updateGoal("chat-1", { action: "PAUSE" })
  const loop = await automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "Check the portfolio",
  })

  await expect(automation.restoreGoal("chat-1", goal)).rejects.toThrow(
    "Cannot restore an active goal",
  )
  await automation.cancelLoop("chat-1", loop.id)
  await automation.updateGoal("chat-1", { action: "RESUME" })
  await expect(automation.restoreLoop("chat-1", loop.id, loop)).rejects.toThrow(
    "Cannot restore an active scheduled task",
  )
})

test("startup preparation pauses an older active goal when persisted scheduled work also exists", async () => {
  const { automation, store, notices } = await harness({ now: () => 1_000 })
  const goal = await automation.createGoal("chat-1", { objective: "Finish the rebalance" })
  await automation.updateGoal("chat-1", { action: "PAUSE" })
  const loop = await automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "Check the portfolio",
  })
  await store.putGoal({ ...goal, status: "ACTIVE" })

  await automation.prepare()

  expect((await automation.state("chat-1")).goal).toMatchObject({
    status: "PAUSED",
    lastEvaluation: "Paused because this chat also has active scheduled tasks. Cancel them before resuming the goal.",
  })
  expect((await automation.state("chat-1")).loops.find((entry) => entry.id === loop.id)?.status).toBe("ACTIVE")
  expect(notices).toEqual([
    "Paused because this chat also has active scheduled tasks. Cancel them before resuming the goal.",
  ])
})

test("an expiring recurring task gets one final run", async () => {
  let now = 1_000
  const { automation, events } = await harness({ now: () => now })
  const loop = await automation.createLoop("chat-1", {
    schedule: "INTERVAL",
    intervalMs: 60_000,
    prompt: "Final check",
    expiresAt: now + 30_000,
  })
  expect(loop.nextRunAt).toBe(now + 30_000)
  now = loop.nextRunAt
  await automation.start()
  expect(events.some((event) => event.referenceId === loop.id)).toBe(true)
  expect((await automation.state("chat-1")).loops[0]?.status).toBe("COMPLETE")
})

test("rejects invalid cron and caps a chat at fifty live scheduled tasks", async () => {
  const { automation } = await harness({ now: () => 1_000 })
  await expect(automation.createLoop("chat-1", {
    schedule: "CRON",
    cronExpression: "every five minutes",
    prompt: "Nope",
  })).rejects.toThrow("Invalid five-field cron expression")

  for (let index = 0; index < 50; index += 1) {
    await automation.createLoop("chat-1", { schedule: "DYNAMIC", prompt: `Task ${index}` })
  }
  await expect(automation.createLoop("chat-1", {
    schedule: "DYNAMIC",
    prompt: "One too many",
  })).rejects.toThrow("50 scheduled tasks")
})

test("pause cancels queued goal work", async () => {
  const { automation, cancelledLabels } = await harness({ now: () => 1_000 })
  await automation.createGoal("chat-1", { objective: "Manage the position" })

  await automation.updateGoal("chat-1", { action: "PAUSE" })
  expect(cancelledLabels).toEqual(["goal"])
  expect((await automation.state("chat-1")).goal?.status).toBe("PAUSED")
})

function reply(totalTokens: number): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "ASSISTANT",
    status: "COMPLETE",
    text: "Worked on it.",
    blocks: [],
    toolName: null,
    toolCallId: null,
    isError: false,
    errorMessage: null,
    usage: { inputTokens: totalTokens, outputTokens: 0, totalTokens, costTotal: 0 },
    model: "model",
    reasoning: "high",
    elapsedMs: 1,
    thinkingMs: null,
    createdAt: 1_000,
  }
}
