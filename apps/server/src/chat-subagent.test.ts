import { afterEach, expect, test } from "bun:test"
import { SubagentConcurrency, type SubagentSessionRecorder } from "@trbot/ai/subagent.ts"
import { testChatHarness } from "@trbot/ai/model.test-fixture.ts"
import { ChatTools } from "@trbot/ai/tool.ts"
import type { ChatApplicationEvent } from "@trbot/chat/session.ts"
import { DrizzleChatSubagentStore } from "@trbot/db/chat-subagent-store.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import { chatSessions } from "@trbot/db/schema.ts"
import { ChatSubagentController } from "./chat-subagent.ts"

let connection: DatabaseConnection | null = null
let controller: ChatSubagentController | null = null

afterEach(() => {
  controller?.destroy()
  controller = null
  connection?.close()
  connection = null
})

test("runs a durable background chain and emits one aggregated completion event", async () => {
  const harness = testChatHarness("worker-model", [() => "First result.", () => "Final result."])
  const context = await setup(harness)

  const started = await controller!.start({
    sessionId: "chat-1",
    parentToolCallId: "tool-1",
    mode: "chain",
    tasks: [
      { agent: "worker", task: "Research" },
      { agent: "worker", task: "Review {previous}" },
    ],
    providerId: harness.model.provider,
    modelId: harness.model.id,
    reasoning: "high",
    automationEvent: null,
  })

  expect(started.status).toBe("QUEUED")
  const event = await context.nextEvent
  expect(event.key).toBe(`subagent:${started.jobId}:COMPLETED`)
  expect(context.events).toHaveLength(1)
  expect(event.prompt).toContain("First result.")
  expect(event.prompt).toContain("Final result.")

  const detail = await controller!.get("chat-1", started.jobId)
  expect(detail).toMatchObject({ status: "COMPLETED", completed: 2, total: 2 })
  expect(detail?.tasks.map((task) => task.task)).toEqual(["Research", "Review First result."])
  expect(detail?.tasks.every((task) => task.sessionIds.length === 1)).toBe(true)
})

test("recovers a running task after restart while retaining its earlier child transcript", async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const firstHarness = testChatHarness("worker-model", [async () => {
    await blocked
    return "Old attempt"
  }])
  const first = await setup(firstHarness)
  const job = await controller!.start({
    sessionId: "chat-1",
    parentToolCallId: "tool-1",
    mode: "single",
    tasks: [{ agent: "worker", task: "Recover me" }],
    providerId: firstHarness.model.provider,
    modelId: firstHarness.model.id,
    reasoning: null,
    automationEvent: null,
  })
  await waitFor(async () => (await first.store.get(job.jobId))?.tasks[0]?.status === "RUNNING")
  controller!.destroy()
  controller = null
  release()

  const recoveredHarness = testChatHarness("worker-model", [() => "Recovered result"])
  const events: ChatApplicationEvent[] = []
  const recoveredEvent = Promise.withResolvers<ChatApplicationEvent>()
  controller = buildController(first.store, recoveredHarness, events, recoveredEvent.resolve, first.sessionIds)
  await controller.prepare()

  await recoveredEvent.promise
  const detail = await controller.get("chat-1", job.jobId)
  expect(detail?.status).toBe("COMPLETED")
  expect(detail?.tasks[0]?.result).toBe("Recovered result")
  expect(detail?.tasks[0]?.sessionIds).toHaveLength(2)
  expect(events).toHaveLength(1)
})

test("shows permission waits and stops a job without deleting its transcript", async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const harness = testChatHarness("worker-model", [async () => {
    await blocked
    return "Too late"
  }])
  const context = await setup(harness)
  const job = await controller!.start({
    sessionId: "chat-1",
    parentToolCallId: "tool-1",
    mode: "single",
    tasks: [{ agent: "worker", task: "Wait" }],
    providerId: harness.model.provider,
    modelId: harness.model.id,
    reasoning: null,
    automationEvent: null,
  })
  await waitFor(async () => context.sessionIds.length === 1)
  context.pending.add(context.sessionIds[0]!)

  expect((await controller!.get("chat-1", job.jobId))?.status).toBe("WAITING_PERMISSION")
  const stopped = await controller!.stop("chat-1", job.jobId)
  expect(stopped?.status).toBe("CANCELLED")
  expect(stopped?.tasks[0]?.sessionIds).toEqual([context.sessionIds[0]])
  expect((await context.nextEvent).key).toBe(`subagent:${job.jobId}:CANCELLED`)
  release()
})

test("keeps workers queued until one of the four root execution slots opens", async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const harness = testChatHarness(
    "worker-model",
    Array.from({ length: 8 }, () => async () => {
      await blocked
      return "Done"
    }),
  )
  const context = await setup(harness)
  const job = await controller!.start({
    sessionId: "chat-1",
    parentToolCallId: "tool-1",
    mode: "parallel",
    tasks: Array.from({ length: 8 }, (_, index) => ({ agent: "worker", task: `Task ${index + 1}` })),
    providerId: harness.model.provider,
    modelId: harness.model.id,
    reasoning: null,
    automationEvent: null,
  })
  await waitFor(async () => context.sessionIds.length === 4)

  const detail = await controller!.get("chat-1", job.jobId)
  expect(detail?.tasks.filter((task) => task.status === "RUNNING")).toHaveLength(4)
  expect(detail?.tasks.filter((task) => task.status === "QUEUED")).toHaveLength(4)

  await controller!.stop("chat-1", job.jobId)
  release()
})

async function setup(harness: ReturnType<typeof testChatHarness>) {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "Test",
    model: harness.model.id,
    provider: harness.model.provider,
    createdAt: 1_000,
    updatedAt: 1_000,
  })
  const store = new DrizzleChatSubagentStore(connection.db)
  const events: ChatApplicationEvent[] = []
  const nextEvent = Promise.withResolvers<ChatApplicationEvent>()
  const sessionIds: string[] = []
  const pending = new Set<string>()
  controller = buildController(store, harness, events, nextEvent.resolve, sessionIds, () => pending)
  return { store, events, nextEvent: nextEvent.promise, sessionIds, pending }
}

function buildController(
  store: DrizzleChatSubagentStore,
  harness: ReturnType<typeof testChatHarness>,
  events: ChatApplicationEvent[],
  resolveEvent: (event: ChatApplicationEvent) => void,
  sessionIds: string[],
  pendingPermissionSessionIds: () => Set<string> = () => new Set(),
): ChatSubagentController {
  const sessions: SubagentSessionRecorder = {
    start: async () => {
      const sessionId = `child-${sessionIds.length + 1}`
      sessionIds.push(sessionId)
      return {
        sessionId,
        onText: () => {},
        onReasoning: () => {},
        onToolCall: () => {},
        onRetry: () => {},
        onMessage: async () => {},
        finish: async () => {},
      }
    },
  }
  return new ChatSubagentController({
    store,
    models: harness.models,
    tools: new ChatTools(),
    sessions,
    concurrency: new SubagentConcurrency(),
    resolveModel: () => harness.model,
    requireRootSession: async (sessionId) => {
      if (sessionId !== "chat-1") throw new Error("Not a root chat")
    },
    pendingPermissionSessionIds,
    enqueueEvent: async (_sessionId, event) => {
      events.push(event)
      resolveEvent(event)
    },
    onError: (error) => { throw error },
  })
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Condition was not reached")
}
