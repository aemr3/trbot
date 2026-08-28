import { afterEach, expect, test } from "bun:test"
import type { ChatSubagentJob, ChatSubagentTask } from "@trbot/chat/subagent.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleChatSubagentStore } from "./chat-subagent-store.ts"
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
  return new DrizzleChatSubagentStore(connection.db)
}

test("creates and round trips a background job with task usage", async () => {
  const store = await setup()
  const job = fixtureJob()
  const task = fixtureTask()

  expect(await store.create(job, [task], 8)).toBe(true)
  expect(await store.get(job.id)).toEqual({ job, tasks: [task] })
  expect(await store.outstanding("chat-1")).toBe(1)

  const completed = {
    ...task,
    status: "COMPLETED" as const,
    result: "Done",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costTotal: 0 },
    updatedAt: 2_000,
    completedAt: 2_000,
  }
  await store.putTask(completed)
  const completedJob = {
    ...job,
    status: "COMPLETED" as const,
    updatedAt: 2_000,
    completedAt: 2_000,
    notifiedAt: null,
  }
  await store.putJob(completedJob)

  expect((await store.get(job.id))?.tasks).toEqual([completed])
  expect(await store.outstanding("chat-1")).toBe(0)
  expect(await store.listRecoverable()).toEqual([{ job: completedJob, tasks: [completed] }])
  await store.putJob({ ...completedJob, notifiedAt: 2_100 })
  expect(await store.listRecoverable()).toEqual([])
})

test("atomically refuses work beyond the root outstanding limit", async () => {
  const store = await setup()
  const first = fixtureJob()
  expect(await store.create(first, Array.from({ length: 8 }, (_, index) => fixtureTask(first.id, index)), 8)).toBe(true)

  const second = fixtureJob("job-2")
  expect(await store.create(second, [fixtureTask(second.id)], 8)).toBe(false)
  expect(await store.get(second.id)).toBeNull()
})

function fixtureJob(id = "job-1"): ChatSubagentJob {
  return {
    id,
    sessionId: "chat-1",
    parentToolCallId: "tool-1",
    mode: "parallel",
    status: "QUEUED",
    providerId: "provider",
    modelId: "model",
    reasoning: "high",
    automationLabel: null,
    automationReferenceId: null,
    error: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    notifiedAt: null,
  }
}

function fixtureTask(jobId = "job-1", index = 0): ChatSubagentTask {
  return {
    jobId,
    index,
    agent: "worker",
    taskTemplate: `Task ${index + 1}`,
    resolvedTask: null,
    sessionIds: [],
    status: "QUEUED",
    result: null,
    error: null,
    usage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  }
}
