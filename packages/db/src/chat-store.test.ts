import { afterEach, describe, expect, test } from "bun:test"
import {
  chatBlockText,
  chatMessageText,
  type ChatBlock,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatSession,
} from "@trbot/chat/session.ts"
import { DrizzleChatSessionStore } from "./chat-store.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { z } from "zod"

const DraftBlockSchema = z.object({
  type: z.enum(["text", "thinking", "toolCall", "image"]),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
}).loose()
const DraftRecordSchema = z.object({
  role: z.enum(["user", "assistant", "toolResult"]),
  content: z.union([z.string(), z.array(DraftBlockSchema)]),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  errorMessage: z.string().optional(),
  responseModel: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  elapsedMs: z.number().optional(),
  thinkingMs: z.number().optional(),
  timestamp: z.number(),
}).loose()
const DraftRecordInputSchema = z.preprocess((value) => value, DraftRecordSchema)

describe("chat session store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  async function store(): Promise<DrizzleChatSessionStore> {
    connection = await openDatabase(":memory:")
    return new DrizzleChatSessionStore(connection.db, { harnessVersion: "pi-ai/test" })
  }

  /**
   * The guarantee behind "a session can always be resumed".
   *
   * Replaying a conversation means handing the model back exactly what it produced,
   * so what comes out of storage has to equal what went in — signatures, usage,
   * tool calls and all. This is the test that fails first if a harness upgrade
   * changes the shape of a message, which is precisely when we want to hear about it.
   */
  test("round-trips every kind of message without losing a field", async () => {
    const chats = await store()
    await chats.create(session())

    const records: unknown[] = [
      { role: "user", content: "What is ASELS trading at?", timestamp: 1_000 },
      {
        role: "assistant",
        content: [
          // A signature is as load-bearing as the words: handed back, the model
          // continues from the reasoning it already did.
          { type: "thinking", thinking: "checking the tape", thinkingSignature: "sig-thinking" },
          { type: "text", text: "Let me look.", textSignature: "sig-text" },
          {
            type: "toolCall",
            id: "call-1",
            name: "quote",
            arguments: { symbol: "ASELS", intraday: true },
            thoughtSignature: "sig-thought",
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        responseModel: "gpt-5.6-sol-2026",
        responseId: "resp-1",
        usage: {
          input: 120,
          output: 45,
          cacheRead: 12,
          cacheWrite: 3,
          totalTokens: 180,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
        stopReason: "toolUse",
        timestamp: 2_000,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "quote",
        content: [{ type: "text", text: "ASELS 390.00" }],
        details: { last: 390, currency: "TRY" },
        isError: false,
        timestamp: 3_000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "390.00." }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: {
          input: 200,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 208,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4_000,
      },
      // Stopped part way, and an outright failure: both are kept, because a reply
      // cut off is worth more than an empty transcript with an error beside it.
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "redacted by the provider", thinkingSignature: "sig-redacted", redacted: true },
          { type: "text", text: "Partial" },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: {
          input: 10,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "aborted",
        timestamp: 5_000,
      },
      {
        role: "assistant",
        content: [],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: {
          input: 5,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "stream lost",
        timestamp: 6_000,
      },
    ]

    for (const record of records) await chats.append("chat-1", draftFor(record))

    expect(await chats.records("chat-1")).toEqual(records)
  })

  test("omits undefined optional harness fields without losing tool calls", async () => {
    const chats = await store()
    await chats.create(session())
    const record = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "call-1", name: "quote", arguments: { symbol: "ASELS" } }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 1_000,
    }
    const draft = draftFor(record)
    draft.record = {
      ...record,
      errorMessage: undefined,
      usage: { ...record.usage, reasoning: undefined },
      content: record.content.map((block) => ({ ...block, namespace: undefined })),
    }

    await chats.append("chat-1", draft)

    expect(await chats.records("chat-1")).toEqual([record])
  })

  test("refuses a non-JSON harness record instead of storing an empty assistant message", async () => {
    const chats = await store()
    await chats.create(session())
    const draft = draftFor({ role: "user", content: "hello", timestamp: 1_000 })
    draft.record = { role: "user", content: "hello", timestamp: 1_000, invalid: 1n }

    await expect(chats.append("chat-1", draft)).rejects.toThrow("Cannot persist chat record")
    expect(await chats.records("chat-1")).toEqual([])
  })

  test("keeps orphaned legacy tool results out of model context", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "Check ASELS", timestamp: 1_000 }))
    await chats.append("chat-1", draftFor({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "quote", arguments: { symbol: "ASELS" } }],
      api: "test",
      provider: "test",
      model: "test",
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 2_000,
    }))
    await chats.append("chat-1", draftFor({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "quote",
      content: [{ type: "text", text: "ASELS 214.30" }],
      isError: false,
      timestamp: 3_000,
    }))
    await chats.append("chat-1", draftFor({
      role: "toolResult",
      toolCallId: "call-without-a-stored-call",
      toolName: "news",
      content: [{ type: "text", text: "orphaned result" }],
      isError: false,
      timestamp: 4_000,
    }))

    const context = await chats.context("chat-1")
    expect(context.records.map((entry) => DraftRecordInputSchema.parse(entry.record).role))
      .toEqual(["user", "assistant", "toolResult"])
    expect((await chats.get("chat-1"))?.messages).toHaveLength(4)
  })

  test("loads a bounded display timeline without changing complete session counts", async () => {
    const chats = await store()
    await chats.create(session())
    const records: Array<z.input<typeof DraftRecordInputSchema>> = [
      { role: "user", content: "old", timestamp: 1_000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "quote", arguments: {} }],
        model: "test",
        timestamp: 2_000,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "quote",
        content: [{ type: "text", text: "old result" }],
        timestamp: 3_000,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "quote", arguments: {} }],
        model: "test",
        timestamp: 4_000,
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "quote",
        content: [{ type: "text", text: "kept result" }],
        timestamp: 5_000,
      },
      { role: "assistant", content: "latest", model: "test", timestamp: 6_000 },
    ]
    for (const record of records) await chats.append("chat-1", draftFor(record))

    const detail = await chats.get("chat-1", 2)

    expect(detail?.messages.map((message) => message.toolCallId ?? message.text)).toEqual([
      "",
      "call-2",
      "latest",
    ])
    expect(detail?.session.messageCount).toBe(records.length)
  })

  test("loads every user prompt independently of the display timeline", async () => {
    const chats = await store()
    await chats.create(session())
    const records: Array<z.input<typeof DraftRecordInputSchema>> = [
      { role: "user", content: "old prompt", timestamp: 1_000 },
      { role: "assistant", content: "old reply", model: "test", timestamp: 2_000 },
      { role: "user", content: "/literal prompt", timestamp: 3_000 },
      { role: "user", content: "/literal prompt", timestamp: 4_000 },
    ]
    for (const record of records) await chats.append("chat-1", draftFor(record))

    expect((await chats.get("chat-1", 1))?.messages).toHaveLength(1)
    expect(await chats.promptHistory("chat-1")).toEqual({ index: 2, prompt: "/literal prompt" })
    expect(await chats.promptHistory("chat-1", 0)).toEqual({ index: 0, prompt: "old prompt" })
    expect(await chats.promptHistory("chat-1", 1)).toEqual({ index: 1, prompt: "/literal prompt" })
    expect(await chats.promptHistory("chat-1", 2)).toEqual({ index: 2, prompt: "/literal prompt" })
    expect(await chats.promptHistory("chat-1", 3)).toEqual({ index: null, prompt: null })
    expect(await chats.promptHistory("missing", 0)).toBeNull()

    await chats.append("chat-1", draftFor({ role: "user", content: "new prompt", timestamp: 5_000 }))
    expect(await chats.promptHistory("chat-1", 1)).toEqual({ index: 1, prompt: "/literal prompt" })
    expect(await chats.promptHistory("chat-1")).toEqual({ index: 3, prompt: "new prompt" })
  })

  test("keeps a field this build does not model, so an older row still replays whole", async () => {
    // A harness upgrade that adds a field must not quietly drop it from every
    // message written before this build learned about it — that is the difference
    // between resuming a conversation and resuming most of one.
    const chats = await store()
    await chats.create(session())
    const record = {
      role: "assistant",
      content: [{ type: "text", text: "Ankara.", futureBlockField: { nested: true } }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        // Real, not hypothetical: the harness reports reasoning tokens for this
        // provider, and usage is rebuilt column by column — so a nested field it
        // has no column for is the easiest one to lose.
        reasoning: 1,
      },
      stopReason: "stop",
      // Also real: the harness records the provider's own terminal reason
      // alongside the one it maps.
      rawStopReason: "completed",
      timestamp: 1_000,
      futureMessageField: ["kept"],
    }

    await chats.append("chat-1", draftFor(record))

    expect(await chats.records("chat-1")).toEqual([record])
  })

  test("keeps the usage a tool result reports", async () => {
    // A tool result carries usage only sometimes, so it is easy to write to the
    // columns and never read back. A tool that costs tokens would then look free.
    const chats = await store()
    await chats.create(session())
    const record = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "quote",
      content: [{ type: "text", text: "ASELS 214.30" }],
      isError: false,
      timestamp: 2_000,
      usage: {
        input: 12,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }

    await chats.append("chat-1", draftFor(record))

    expect(await chats.records("chat-1")).toEqual([record])
  })

  test("a tool result that reports no usage does not come back inventing one", async () => {
    const chats = await store()
    await chats.create(session())
    const record = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "quote",
      content: [{ type: "text", text: "ASELS 214.30" }],
      isError: false,
      timestamp: 2_000,
    }

    await chats.append("chat-1", draftFor(record))

    expect(await chats.records("chat-1")).toEqual([record])
  })

  test("keeps what answered a message, how hard it was thinking, and how long it took", async () => {
    // A session can be pointed at another model, so this is the only record of what
    // wrote a given reply — and the effort it was asked for is not in the harness's
    // own message at all.
    const chats = await store()
    await chats.create(session())
    const record = {
      role: "assistant",
      content: [{ type: "text", text: "Thin volumes into the print." }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      // What actually answered: a provider can route a request to a dated snapshot.
      responseModel: "gpt-5.6-sol-2026-08-01",
      reasoning: "high",
      elapsedMs: 4_040,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_000,
    }

    await chats.append("chat-1", draftFor(record))

    const detail = await chats.get("chat-1")
    expect(detail?.messages[0]?.model).toBe("gpt-5.6-sol-2026-08-01")
    expect(detail?.messages[0]?.reasoning).toBe("high")
    expect(detail?.messages[0]?.elapsedMs).toBe(4_040)
  })

  test("orders a conversation by when each message was written, not when it ran", async () => {
    const chats = await store()
    await chats.create(session())
    for (const text of ["first", "second", "third"]) {
      await chats.append("chat-1", draftFor({ role: "user", content: text, timestamp: 1_000 }))
    }

    const detail = await chats.get("chat-1")
    expect(detail?.messages.map((message) => message.text)).toEqual(["first", "second", "third"])
  })

  test("leaves a queued message out of what the model is told", async () => {
    // A message waiting its turn has not been said yet. Replaying it as history
    // would ask the model to answer the same question twice.
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "asked", timestamp: 1_000 }, "SENT"))
    await chats.append("chat-1", draftFor({ role: "user", content: "waiting", timestamp: 2_000 }, "QUEUED"))

    expect(await chats.records("chat-1")).toEqual([{ role: "user", content: "asked", timestamp: 1_000 }])
    const detail = await chats.get("chat-1")
    expect(detail?.messages).toHaveLength(2)
    expect(detail?.session.queued).toBe(1)
  })

  test("rebuilds model context from a rolling checkpoint without changing the transcript", async () => {
    const chats = await store()
    await chats.create(session())
    for (const [text, timestamp] of [["old question", 1_000], ["old answer", 2_000], ["recent question", 3_000]] as const) {
      const role = text.includes("answer") ? "assistant" : "user"
      await chats.append("chat-1", draftFor(role === "user"
        ? { role, content: text, timestamp }
        : {
            role,
            content: [{ type: "text", text }],
            api: "test",
            provider: "test",
            model: "test",
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp,
          }))
    }

    const before = await chats.context("chat-1")
    await chats.saveCompaction({
      sessionId: "chat-1",
      summary: "The user asked an earlier question and received an answer.",
      compactedThroughSeq: before.records[1]!.seq,
      firstKeptSeq: before.records[2]!.seq,
      tokensBefore: 90_000,
      tokensAfter: 9_000,
      createdAt: 4_000,
    })

    const active = await chats.context("chat-1")
    expect(active.compaction?.summary).toContain("earlier question")
    expect(active.records.map((entry) => z.string().parse(DraftRecordInputSchema.parse(entry.record).content)))
      .toEqual(["recent question"])
    expect((await chats.get("chat-1"))?.messages.map((message) => message.text)).toEqual([
      "old question",
      "old answer",
      "recent question",
    ])
    expect(await chats.records("chat-1")).toHaveLength(3)
  })

  test("includes messages appended after a checkpoint that retained no old tail", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "old", timestamp: 1_000 }))
    const old = await chats.context("chat-1")
    await chats.saveCompaction({
      sessionId: "chat-1",
      summary: "Old discussion.",
      compactedThroughSeq: old.records[0]!.seq,
      firstKeptSeq: null,
      tokensBefore: 80_000,
      tokensAfter: 8_000,
      createdAt: 2_000,
    })
    await chats.append("chat-1", draftFor({ role: "user", content: "new", timestamp: 3_000 }))

    expect((await chats.context("chat-1")).records.map((entry) =>
      z.string().parse(DraftRecordInputSchema.parse(entry.record).content)))
      .toEqual(["new"])
  })

  test("stores one application event key while keeping its model prompt private", async () => {
    const chats = await store()
    await chats.create(session())
    const visible = "ASELS crossed above 420 at 421."
    const prompt = "<price_alert_triggered>continue the setup</price_alert_triggered>"
    const draft: ChatMessageDraft = {
      message: {
        id: "event-1",
        role: "APP_EVENT",
        status: "QUEUED",
        text: visible,
        blocks: [chatBlockText(visible)],
        toolName: null,
        toolCallId: null,
        isError: false,
        errorMessage: null,
        usage: null,
        model: null,
        reasoning: null,
        elapsedMs: null,
        thinkingMs: null,
        createdAt: 2_000,
      },
      record: { role: "user", content: prompt, timestamp: 2_000 },
    }

    expect(await chats.appendEvent("chat-1", draft, "price-alert:trigger-1")).toBe(true)
    expect(await chats.appendEvent("chat-1", {
      ...draft,
      message: { ...draft.message, id: "event-duplicate" },
    }, "price-alert:trigger-1")).toBe(false)
    expect(await chats.inputText("event-1")).toBe(prompt)
    expect((await chats.get("chat-1"))?.messages).toMatchObject([{ role: "APP_EVENT", text: visible }])

    await chats.markSent("event-1")
    expect(await chats.records("chat-1")).toEqual([{ role: "user", content: prompt, timestamp: 2_000 }])
  })

  test("a question queued behind another lands after that one's answer", async () => {
    // A message takes its place in the queue when written, but its place in the
    // conversation only when asked. Without the move, the model would be replayed
    // question, question, answer — an order the conversation never had.
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "first", timestamp: 1_000 }, "QUEUED"))
    await chats.append("chat-1", draftFor({ role: "user", content: "second", timestamp: 2_000 }, "QUEUED"))

    const queued = (await chats.get("chat-1"))?.messages ?? []
    await chats.markSent(queued[0]?.id ?? "")
    await chats.append("chat-1", draftFor({ role: "assistant", content: [{ type: "text", text: "answer to first" }], api: "a", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3_000 }))

    // What has been said, in the order it was said, and what is still waiting after it.
    const detail = await chats.get("chat-1")
    expect(detail?.messages.map((message) => message.text)).toEqual([
      "first",
      "answer to first",
      "second",
    ])
    expect((await chats.records("chat-1")).map((record) => DraftRecordInputSchema.parse(record).role)).toEqual([
      "user",
      "assistant",
    ])
  })

  test("reports which sessions have work waiting, so a restart picks it up", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.create({ ...session(), id: "chat-2" })
    await chats.append("chat-1", draftFor({ role: "user", content: "waiting", timestamp: 1_000 }, "QUEUED"))
    await chats.append("chat-2", draftFor({ role: "user", content: "done", timestamp: 1_000 }, "SENT"))

    expect(await chats.queuedSessionIds()).toEqual(["chat-1"])
  })

  test("removing a message takes its blocks with it", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "waiting", timestamp: 1_000 }, "QUEUED"))
    const detail = await chats.get("chat-1")
    const messageId = detail?.messages[0]?.id ?? ""

    await chats.remove(messageId)

    expect((await chats.get("chat-1"))?.messages).toEqual([])
    expect(await chats.records("chat-1")).toEqual([])
  })

  test("rewinds from a prompt and clears compacted context", async () => {
    const chats = await store()
    await chats.create(session())
    for (const [role, content, timestamp] of [
      ["user", "first question", 1_000],
      ["assistant", "first answer", 2_000],
      ["user", "second question", 3_000],
      ["assistant", "second answer", 4_000],
    ] as const) {
      await chats.append("chat-1", draftFor(role === "user"
        ? { role, content, timestamp }
        : { role, content, model: "test", timestamp }))
    }
    const before = await chats.context("chat-1")
    await chats.saveCompaction({
      sessionId: "chat-1",
      summary: "Both exchanges, including the one about to be removed.",
      compactedThroughSeq: before.records[2]!.seq,
      firstKeptSeq: before.records[3]!.seq,
      tokensBefore: 80_000,
      tokensAfter: 8_000,
      createdAt: 5_000,
    })
    const target = (await chats.get("chat-1"))?.messages.find((message) => message.text === "second question")
    if (!target) throw new Error("missing rewind target")

    const removed = await chats.rewindFrom("chat-1", target.id)

    expect(removed).toHaveLength(2)
    expect(removed).toContain(target.id)
    expect((await chats.get("chat-1"))?.messages.map((message) => message.text)).toEqual([
      "first question",
      "first answer",
    ])
    const context = await chats.context("chat-1")
    expect(context.compaction).toBeNull()
    expect(context.records).toHaveLength(2)
  })

  test("journals tool effects outside model context and finds them from a rewind point", async () => {
    const chats = await store()
    await chats.create(session())
    const prompt = draftFor({ role: "user", content: "watch ASELS", timestamp: 1_000 })
    await chats.append("chat-1", prompt)
    const result = draftFor({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "create_market_monitor",
      content: [{ type: "text", text: "created" }],
      isError: false,
      timestamp: 2_000,
    })
    result.effects = [{
      kind: "MARKET_MONITOR",
      resourceId: "monitor-1",
      description: "Market monitor was created",
      reversible: true,
      before: null,
      after: { id: "monitor-1" },
    }]
    await chats.append("chat-1", result)

    expect(await chats.effectsFrom("chat-1", prompt.message.id)).toEqual(result.effects)
    expect(await chats.records("chat-1")).toEqual([prompt.record, result.record])
  })

  test("deleting a session takes its messages with it", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "asked", timestamp: 1_000 }, "SENT"))

    await chats.delete("chat-1")

    expect(await chats.get("chat-1")).toBeNull()
    expect(await chats.list()).toEqual([])
    // The messages go too: rows pointing at a session that no longer exists would
    // still be counted the next time anything reads them.
    expect(await chats.records("chat-1")).toEqual([])
  })

  test("points a session at a different model without touching what was said in it", async () => {
    // The transcript records which model wrote each reply, so changing the session's
    // model must not rewrite history — only what answers next.
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "Where is ASELS heading?", timestamp: 1_000 }))

    await chats.configure("chat-1", { providerId: "anthropic", modelId: "claude-fable-5", reasoning: "max" })

    const detail = await chats.get("chat-1")
    expect(detail?.session.provider).toBe("anthropic")
    expect(detail?.session.model).toBe("claude-fable-5")
    expect(detail?.session.reasoning).toBe("max")
    expect(detail?.messages.map((message) => message.text)).toEqual(["Where is ASELS heading?"])
  })

test("renames a session without touching what was said in it", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "asked", timestamp: 1_000 }, "SENT"))

    await chats.rename("chat-1", "ASELS setup")

    const detail = await chats.get("chat-1")
    expect(detail?.session.title).toBe("ASELS setup")
    expect(detail?.messages).toHaveLength(1)
  })

test("replaces only the automatic title a background job started from", async () => {
    const chats = await store()
    await chats.create(session())

    expect(await chats.replaceAutomaticTitle("chat-1", "New chat", "Review ASELS setup")).toBe(true)
    expect(await chats.replaceAutomaticTitle("chat-1", "New chat", "Stale title")).toBe(false)
    await chats.rename("chat-1", "My notes")
    expect(await chats.replaceAutomaticTitle("chat-1", "My notes", "Generated title")).toBe(false)
    expect((await chats.get("chat-1"))?.session.title).toBe("My notes")
  })

test("keeps child sessions out of the root list and finds them through their parent", async () => {
  const chats = await store()
  const parent = session()
  const child: ChatSession = {
    ...session(),
    id: "child-1",
    title: "Inspect ASELS",
    parentSessionId: parent.id,
    parentPromptMessageId: "prompt-1",
    parentToolCallId: "call-subagent",
    agent: "worker",
    createdAt: 2_000,
    updatedAt: 2_000,
  }
  await chats.create(parent)
  await chats.create(child)

  expect((await chats.list()).map((entry) => entry.id)).toEqual([parent.id])
  expect(await chats.listChildren(parent.id)).toMatchObject([{
    id: child.id,
    parentSessionId: parent.id,
    parentPromptMessageId: "prompt-1",
    parentToolCallId: "call-subagent",
    agent: "worker",
  }])
  expect((await chats.get(child.id))?.session.parentPromptMessageId).toBe("prompt-1")

  await chats.append(child.id, draftFor({ role: "user", content: "delegated task", timestamp: 2_000 }, "SENT"))
  await chats.delete(parent.id)
  expect(await chats.get(child.id)).toBeNull()
})
})

function session(): ChatSession {
  return {
    id: "chat-1",
    title: "New chat",
    parentSessionId: null,
    parentPromptMessageId: null,
    parentToolCallId: null,
    agent: null,
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    reasoning: "high",
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: 0,
    queued: 0,
    running: false,
  }
}

/**
 * Builds the message a client renders beside the harness record it was made from.
 * The controller does this for real; here it only has to be consistent.
 */
function draftFor(
  record: z.input<typeof DraftRecordInputSchema>,
  status: ChatMessage["status"] = "COMPLETE",
): ChatMessageDraft {
  const value = DraftRecordInputSchema.parse(record)
  const role = value.role === "user" ? "USER" : value.role === "toolResult" ? "TOOL_RESULT" : "ASSISTANT"
  const blocks = Array.isArray(value.content)
    ? value.content.map((block): ChatBlock => ({
        kind: block.type === "thinking"
          ? "THINKING"
          : block.type === "toolCall"
            ? "TOOL_CALL"
            : "TEXT",
        text: block.type === "thinking" ? block.thinking ?? null : block.text ?? null,
        toolName: block.name ?? null,
        toolCallId: block.id ?? null,
        toolArguments: block.arguments ?? null,
      }))
    : [chatBlockText(value.content)]

  return {
    message: {
      id: crypto.randomUUID(),
      role,
      status,
      text: chatMessageText(blocks),
      blocks,
      toolName: value.toolName ?? null,
      toolCallId: value.toolCallId ?? null,
      isError: value.isError === true,
      errorMessage: value.errorMessage ?? null,
      usage: null,
      model: value.responseModel ?? value.model ?? null,
      reasoning: value.reasoning ?? null,
      elapsedMs: value.elapsedMs ?? null,
      thinkingMs: value.thinkingMs ?? null,
      createdAt: value.timestamp,
    },
    record: value,
  }
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}
