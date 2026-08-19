import { afterEach, describe, expect, test } from "bun:test"
import {
  chatBlockText,
  chatMessageText,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatSession,
} from "@trbot/chat/session.ts"
import { DrizzleChatSessionStore } from "./chat-store.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"

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
    expect((await chats.records("chat-1")).map((record) => (record as { role: string }).role)).toEqual([
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

  test("renames a session without touching what was said in it", async () => {
    const chats = await store()
    await chats.create(session())
    await chats.append("chat-1", draftFor({ role: "user", content: "asked", timestamp: 1_000 }, "SENT"))

    await chats.rename("chat-1", "ASELS setup")

    const detail = await chats.get("chat-1")
    expect(detail?.session.title).toBe("ASELS setup")
    expect(detail?.messages).toHaveLength(1)
  })
})

function session(): ChatSession {
  return {
    id: "chat-1",
    title: "New chat",
    model: "gpt-5.6-sol",
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
function draftFor(record: unknown, status: ChatMessage["status"] = "COMPLETE"): ChatMessageDraft {
  const value = record as Record<string, unknown>
  const role = value.role === "user" ? "USER" : value.role === "toolResult" ? "TOOL_RESULT" : "ASSISTANT"
  const blocks = typeof value.content === "string"
    ? [chatBlockText(value.content)]
    : (value.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[])
      .map((block) => ({
        kind: block.type === "thinking"
          ? ("THINKING" as const)
          : block.type === "toolCall"
            ? ("TOOL_CALL" as const)
            : ("TEXT" as const),
        text: block.type === "thinking" ? block.thinking ?? null : block.text ?? null,
        toolName: block.name ?? null,
        toolCallId: block.id ?? null,
        toolArguments: block.arguments ?? null,
      }))

  return {
    message: {
      id: crypto.randomUUID(),
      role,
      status,
      text: chatMessageText(blocks),
      blocks,
      toolName: (value.toolName as string | undefined) ?? null,
      toolCallId: (value.toolCallId as string | undefined) ?? null,
      isError: value.isError === true,
      errorMessage: (value.errorMessage as string | undefined) ?? null,
      usage: null,
      createdAt: value.timestamp as number,
    },
    record,
  }
}
