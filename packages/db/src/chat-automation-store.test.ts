import { afterEach, expect, test } from "bun:test"
import type { ChatGoal, ChatLoop } from "@trbot/chat/automation.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleChatAutomationStore } from "./chat-automation-store.ts"
import { chatSessions } from "./schema.ts"

let connection: DatabaseConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

async function setup() {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "Test",
    model: "model",
    provider: "provider",
    createdAt: 1_000,
    updatedAt: 1_000,
  })
  return new DrizzleChatAutomationStore(connection.db)
}

test("round trips a goal", async () => {
  const store = await setup()
  const goal: ChatGoal = {
    id: "goal-1",
    sessionId: "chat-1",
    objective: "Finish analysis",
    status: "ACTIVE",
    turnCount: 2,
    maxTurns: null,
    tokenBudget: 10_000,
    startedTokens: 500,
    usedTokens: 900,
    lastEvaluation: "More work remains.",
    pendingEventKey: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
  await store.putGoal(goal)
  expect(await store.getGoal("chat-1")).toEqual(goal)
  expect(await store.listActiveGoals()).toEqual([goal])
})

test("returns only active loops whose next run is due", async () => {
  const store = await setup()
  const base: ChatLoop = {
    id: "loop-due",
    sessionId: "chat-1",
    prompt: "Refresh positions",
    usesDefaultPrompt: false,
    schedule: "INTERVAL",
    intervalMs: 60_000,
    cronExpression: null,
    status: "ACTIVE",
    nextRunAt: 2_000,
    lastRunAt: null,
    runCount: 0,
    maxRuns: null,
    expiresAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  await store.putLoop(base)
  await store.putLoop({ ...base, id: "loop-later", nextRunAt: 4_000 })
  await store.putLoop({ ...base, id: "loop-paused", status: "PAUSED" })

  expect((await store.listDueLoops(3_000)).map((loop) => loop.id)).toEqual(["loop-due"])
})
