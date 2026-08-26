import { expect, test } from "bun:test"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import type { ChatContextRecord, ChatModelContext } from "@trbot/chat/session.ts"
import { ChatCompactor, selectRecentTurns } from "./compaction.ts"

function harness() {
  const faux = fauxProvider({ models: [{ id: "compact-model", contextWindow: 1_000, maxTokens: 500 }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models }
}

test("compacts the old prefix and keeps recent complete turns verbatim", async () => {
  const { faux, models } = harness()
  faux.setResponses([
    (context) => {
      const prompt = context.messages[0]
      expect(prompt?.role).toBe("user")
      expect(JSON.stringify(prompt)).toContain("Previous objective")
      expect(JSON.stringify(prompt)).toContain("old question")
      expect(JSON.stringify(prompt)).not.toContain("recent question")
      return fauxAssistantMessage("Objective:\n- Updated objective\n\nPending:\n- Review ASELS")
    },
  ])
  const context: ChatModelContext = {
    compaction: {
      sessionId: "chat-1",
      summary: "Previous objective",
      compactedThroughSeq: 2,
      firstKeptSeq: 3,
      tokensBefore: 900,
      tokensAfter: 90,
      createdAt: 2_000,
    },
    records: [
      record(3, { role: "user", content: `old question ${"x".repeat(800)}`, timestamp: 3_000 }),
      record(4, assistant("old answer", 4_000)),
      record(5, { role: "user", content: "recent question", timestamp: 5_000 }),
      record(6, assistant("recent answer", 6_000)),
    ],
  }
  const compactor = new ChatCompactor({ models, keepRecentTokens: 20, reserveTokens: 100, now: () => 7_000 })

  const result = await compactor.compact({
    sessionId: "chat-1",
    model: faux.getModel(),
    context,
    prompt: "next question",
  })

  expect(result?.checkpoint).toMatchObject({
    sessionId: "chat-1",
    compactedThroughSeq: 4,
    firstKeptSeq: 5,
    createdAt: 7_000,
  })
  expect(result?.history.map((message) => message.role)).toEqual(["user", "user", "assistant"])
  expect(JSON.stringify(result?.history[0])).toContain("Updated objective")
  expect(JSON.stringify(result?.history[1])).toContain("recent question")
})

test("does nothing below the model threshold", async () => {
  const { faux, models } = harness()
  const compactor = new ChatCompactor({ models, reserveTokens: 100 })
  const result = await compactor.compact({
    sessionId: "chat-1",
    model: faux.getModel(),
    context: { compaction: null, records: [record(1, { role: "user", content: "hello", timestamp: 1 })] },
    prompt: "next",
  })
  expect(result).toBeNull()
})

test("keeps tool results with the turn that called them", () => {
  const records = [
    record(1, { role: "user", content: `large ${"x".repeat(200)}`, timestamp: 1 }),
    record(2, assistant("first", 2)),
    record(3, { role: "user", content: "latest", timestamp: 3 }),
    record(4, assistant("second", 4)),
  ]
  expect(selectRecentTurns(records, 10)).toBe(2)
  expect(selectRecentTurns(records, 1)).toBe(4)
})

function record<T>(seq: number, value: T): ChatContextRecord {
  return { id: `message-${seq}`, seq, record: value }
}

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test" as const,
    provider: "test",
    model: "compact-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  }
}
