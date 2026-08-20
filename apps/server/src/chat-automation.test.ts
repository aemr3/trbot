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
  const evaluations = [...(options.evaluations ?? [])]
  const detail = (): ChatSessionDetail => ({
    session: {
      id: "chat-1",
      title: "Test",
      parentSessionId: null,
      agent: null,
      model: "model",
      provider: "provider",
      reasoning: "high",
      createdAt: 1_000,
      updatedAt: 1_000,
      messageCount: messages.length,
      queued: 0,
      running: false,
    },
    messages,
    partial: null,
  })
  controller = new ChatAutomationController({
    store: new DrizzleChatAutomationStore(connection.db),
    detail: async () => detail(),
    enqueueEvent: async (_sessionId, event) => { events.push(event) },
    cancelQueuedEvents: async (_sessionId, label) => { cancelledLabels.push(label) },
    resolveModel: async () => ({ model }),
    evaluator: {
      evaluate: async () => evaluations.shift() ?? { verdict: "COMPLETE", reason: "Done." },
    },
    defaultLoopPrompt: options.defaultLoopPrompt,
    notify: async ({ message }) => { notices.push(message) },
    onError: (error) => { throw error },
    now: options.now,
    pollMs: 3_600_000,
  })
  return { automation: controller, messages, events, notices, cancelledLabels }
}

test("a goal starts immediately and a separate evaluator controls continuation", async () => {
  const { automation, messages, events, notices } = await harness({
    evaluations: [
      { verdict: "CONTINUE", reason: "One verification remains." },
      { verdict: "COMPLETE", reason: "The result is verified." },
    ],
  })
  const goal = await automation.createGoal("chat-1", { objective: "Verify the setup" })
  expect(goal.turnCount).toBe(1)
  expect(events[0]?.label).toBe("goal")

  messages.push(reply(100))
  await automation.onTurnSettled("chat-1")
  expect(events).toHaveLength(2)
  expect((await automation.state("chat-1")).goal?.lastEvaluation).toBe("One verification remains.")

  messages.push(reply(200))
  await automation.onTurnSettled("chat-1")
  const finished = (await automation.state("chat-1")).goal
  expect(finished?.status).toBe("COMPLETE")
  expect(finished?.usedTokens).toBe(300)
  expect(notices).toEqual(["The result is verified."])
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

test("pause cancels queued goal work and runtime authority comes only from persisted state", async () => {
  const { automation, cancelledLabels } = await harness({ now: () => 1_000 })
  const executionPolicy = {
    mode: "AUTONOMOUS" as const,
    symbols: ["F_ASELS0826"],
    maxContractsPerOrder: 1,
    maxPositionSize: 2,
    maxDailyLoss: 500,
    allowedOrderTypes: ["LIMIT" as const],
    expiresAt: 10_000,
  }
  const goal = await automation.createGoal("chat-1", { objective: "Manage the position", executionPolicy })

  expect(await automation.executionPolicyForEvent("chat-1", "goal", goal.id)).toEqual(executionPolicy)
  expect(await automation.executionPolicyForEvent("chat-1", "goal", "untrusted-id")).toEqual({
    mode: "ANALYSIS_ONLY",
  })

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
