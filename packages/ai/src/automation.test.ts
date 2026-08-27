import { expect, test } from "bun:test"
import { ChatGoalSchema, type ChatLoop } from "@trbot/chat/automation.ts"
import { automationTools, type ChatAutomationToolsClient } from "./automation.ts"
import { ChatTools } from "./tool.ts"

test("a dynamic loop can choose its next delay only from its own wake-up turn", async () => {
  const calls: Array<{ sessionId: string; loopId: string; intervalMs: number }> = []
  const loop: ChatLoop = {
    id: "loop-1",
    sessionId: "chat-1",
    prompt: "Check deployment",
    usesDefaultPrompt: false,
    schedule: "DYNAMIC",
    intervalMs: 60_000,
    cronExpression: null,
    status: "ACTIVE",
    nextRunAt: 61_000,
    lastRunAt: null,
    runCount: 0,
    maxRuns: null,
    expiresAt: 604_801_000,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  const unavailable = async (): Promise<never> => {
    throw new Error("Only rescheduling is used in this test")
  }
  const client: ChatAutomationToolsClient = {
    state: async () => ({ goal: null, loops: [loop] }),
    createGoal: unavailable,
    finishGoal: unavailable,
    createLoop: unavailable,
    rescheduleLoop: async (sessionId: string, loopId: string, intervalMs: number) => {
      calls.push({ sessionId, loopId, intervalMs })
      return { ...loop, intervalMs }
    },
    cancelLoop: unavailable,
  }
  const tools = new ChatTools(automationTools(client))
  const call = {
    type: "toolCall" as const,
    id: "call-1",
    name: "reschedule_loop",
    arguments: { loop_id: "loop-1", next_interval_minutes: 12 },
  }

  const refused = await tools.call(call, { chatSessionId: "chat-1" })
  expect(refused.isError).toBe(true)

  const accepted = await tools.call(call, {
    chatSessionId: "chat-1",
    automationEvent: { label: "loop", referenceId: "loop-1" },
  })
  expect(accepted.isError).toBe(false)
  expect(calls).toEqual([{ sessionId: "chat-1", loopId: "loop-1", intervalMs: 720_000 }])
})

test("a goal wake-up can finish only the goal that created it", async () => {
  const current = ChatGoalSchema.parse({
    id: "goal-new",
    sessionId: "chat-1",
    objective: "Replacement",
    status: "ACTIVE",
    turnCount: 1,
    maxTurns: null,
    tokenBudget: null,
    startedTokens: 0,
    usedTokens: 0,
    lastEvaluation: null,
    pendingEventKey: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  })
  const expectedGoalIds: Array<string | null> = []
  const unavailable = async (): Promise<never> => { throw new Error("Not used") }
  const tools = new ChatTools(automationTools({
    state: async () => ({ goal: current, loops: [] }),
    createGoal: unavailable,
    finishGoal: async (_sessionId, _status, _reason, expected) => {
      expectedGoalIds.push(expected)
      return { goal: current, notification: null }
    },
    createLoop: unavailable,
    rescheduleLoop: unavailable,
    cancelLoop: unavailable,
  }))

  const result = await tools.call({
    type: "toolCall",
    id: "finish-old-goal",
    name: "update_goal",
    arguments: { status: "COMPLETE", reason: "Finished old objective" },
  }, {
    chatSessionId: "chat-1",
    automationEvent: { label: "goal", referenceId: "goal-old" },
  })

  expect(result.isError).toBe(false)
  expect(expectedGoalIds).toEqual(["goal-old"])
})
