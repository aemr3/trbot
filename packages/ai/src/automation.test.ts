import { expect, test } from "bun:test"
import type { ChatLoop } from "@trbot/chat/automation.ts"
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
