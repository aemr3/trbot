import { expect, test } from "bun:test"
import type { ChatLoop } from "@trbot/chat/automation.ts"
import type { ChatToolEffect } from "@trbot/chat/session.ts"
import { ChatRewindEffects } from "./chat-rewind.ts"

function loop(intervalMs: number): ChatLoop {
  return {
    id: "loop-1",
    sessionId: "chat-1",
    prompt: "Check the position",
    usesDefaultPrompt: false,
    schedule: "DYNAMIC",
    intervalMs,
    cronExpression: null,
    status: "ACTIVE",
    nextRunAt: 10_000 + intervalMs,
    lastRunAt: null,
    runCount: 0,
    maxRuns: null,
    expiresAt: 999_999_999,
    createdAt: 1_000,
    updatedAt: intervalMs,
  }
}

function effect(before: ChatLoop | null, after: ChatLoop | null): ChatToolEffect {
  return {
    kind: "CHAT_LOOP",
    resourceId: "loop-1",
    description: after && before ? "Scheduled task was rescheduled" : "Scheduled task was created",
    reversible: true,
    before,
    after,
  }
}

test("reverts app-owned effects newest first and preserves external actions", async () => {
  const first = loop(60_000)
  const second = loop(120_000)
  let current: ChatLoop | null = second
  const restored: Array<ChatLoop | null> = []
  const rewind = new ChatRewindEffects({
    marketMonitors: { get: () => null, restore: async () => {} },
    stops: { get: () => null, restore: async () => {} },
    notifications: { list: () => [], restore: async () => {} },
    automations: {
      state: async () => ({ goal: null, loops: current ? [current] : [] }),
      restoreGoal: async () => {},
      restoreLoop: async (_sessionId, _loopId, restoredLoop) => {
        current = restoredLoop
        restored.push(restoredLoop)
      },
    },
  })
  const effects: ChatToolEffect[] = [
    effect(null, first),
    effect(first, second),
    {
      kind: "EXTERNAL",
      resourceId: null,
      description: "VIOP order was placed",
      reversible: false,
      before: null,
      after: null,
    },
  ]

  expect(await rewind.preview(effects)).toEqual([
    { description: "Scheduled task was created", reversible: true },
    { description: "Scheduled task was rescheduled", reversible: true },
    { description: "VIOP order was placed", reversible: false },
  ])
  const result = await rewind.revert("chat-1", effects)

  expect(restored).toEqual([first, null])
  expect(current).toBeNull()
  expect(result.reverted).toEqual(["Scheduled task was created", "Scheduled task was rescheduled"])
  expect(result.preserved).toEqual(["VIOP order was placed"])
})

test("preserves a resource that changed after the recorded tool call", async () => {
  const before = loop(60_000)
  const after = loop(120_000)
  const changed = loop(180_000)
  let restoreCalls = 0
  const rewind = new ChatRewindEffects({
    marketMonitors: { get: () => null, restore: async () => {} },
    stops: { get: () => null, restore: async () => {} },
    notifications: { list: () => [], restore: async () => {} },
    automations: {
      state: async () => ({ goal: null, loops: [changed] }),
      restoreGoal: async () => {},
      restoreLoop: async () => { restoreCalls += 1 },
    },
  })

  expect(await rewind.preview([effect(before, after)])).toEqual([{
    description: "Scheduled task was rescheduled (state changed since then)",
    reversible: false,
  }])
  expect(await rewind.revert("chat-1", [effect(before, after)])).toEqual({
    reverted: [],
    preserved: ["Scheduled task was rescheduled"],
  })
  expect(restoreCalls).toBe(0)
})
