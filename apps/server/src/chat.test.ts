import { afterEach, expect, test } from "bun:test"
import type { ChatRecord, ChatTurnOptions, ChatTurnResult } from "@trbot/ai/chat.ts"
import type { ChatCompactionRunner } from "@trbot/ai/compaction.ts"
import { chatBlockText, type ChatMessageDraft } from "@trbot/chat/session.ts"
import { DrizzleChatSessionStore } from "@trbot/db/chat-store.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import { isProtocolError } from "@trbot/protocol/error.ts"
import { ChatController, type ChatTurnRunner } from "./chat.ts"
import type { ExecutionPolicy } from "@trbot/trading/execution-policy.ts"

let connection: DatabaseConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

interface Harness {
  chat: ChatController
  frames: ChatFrame[]
  store: DrizzleChatSessionStore
  /** Every turn the runner was asked for, in order. */
  turns: ChatTurnOptions[]
  /** Lets a test hold a turn open and decide when it finishes. */
  finish(result?: Partial<ChatTurnResult>): void
  errors: unknown[]
}

/**
 * A controller over a real store and a runner the test drives.
 *
 * The store is real because the queue's behaviour is mostly about what survives in
 * it; the runner is not, because none of this is about the model.
 */
async function harness(options: {
  connected?: boolean
  auto?: boolean
  compaction?: ChatCompactionRunner
  generateTitle?: (message: string, signal: AbortSignal) => Promise<string | null>
  run?: (turn: ChatTurnOptions, call: number) => Promise<ChatTurnResult>
  executionPolicyForEvent?: (label: string | null, referenceId: string | null) => Promise<ExecutionPolicy>
} = {}): Promise<Harness> {
  connection = await openDatabase(":memory:")
  const store = new DrizzleChatSessionStore(connection.db, { harnessVersion: "pi-ai/test" })
  const frames: ChatFrame[] = []
  const errors: unknown[] = []
  const turns: ChatTurnOptions[] = []
  let release: ((result: ChatTurnResult) => void) | null = null

  const runner: ChatTurnRunner = {
    run: async (turn) => {
      turns.push(turn)
      if (options.run) return await options.run(turn, turns.length)
      // A turn writes its reply the way the agent does, so the transcript a test
      // reads back is the one the real thing would leave.
      await turn.events.onMessage(reply(`answer to ${turn.prompt}`))
      if (options.auto !== false) return { completed: true, aborted: false, errorMessage: null }
      return await new Promise<ChatTurnResult>((resolve) => {
        release = resolve
      })
    },
  }

  const chat = new ChatController({
    store,
    agent: runner,
    compaction: options.compaction,
    defaultChoice: async () => ({ providerId: "test-provider", modelId: "test-model", reasoning: "high" }),
    // The controller only needs something a turn can run on; which model that is
    // belongs to the harness, and none of this is about the model.
    resolveModel: async (choice) => ({
      model: { id: choice.modelId, provider: choice.providerId } as never,
      reasoningEffort: choice.reasoning,
    }),
    generateTitle: options.generateTitle
      ? ({ message, signal }) => options.generateTitle!(message, signal)
      : undefined,
    requireModel: async () => {
      if (options.connected === false) throw new Error("test-provider is not connected")
    },
    executionPolicyForEvent: options.executionPolicyForEvent
      ? (_sessionId, label, referenceId) => options.executionPolicyForEvent!(label, referenceId)
      : undefined,
    broadcast: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  })
  await chat.start()

  return {
    chat,
    frames,
    store,
    turns,
    errors,
    finish: (result = {}) =>
      release?.({ completed: true, aborted: false, errorMessage: null, ...result }),
  }
}

function reply(text: string): ChatMessageDraft {
  return {
    message: {
      id: crypto.randomUUID(),
      role: "ASSISTANT",
      status: "COMPLETE",
      text,
      blocks: [chatBlockText(text)],
      toolName: null,
      toolCallId: null,
      isError: false,
      errorMessage: null,
      usage: null,
      model: "test-model",
      reasoning: "high",
      elapsedMs: 1_200,
      thinkingMs: 400,
      createdAt: Date.now(),
    },
    record: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  }
}

async function settle(): Promise<void> {
  // The drain runs outside the request that started it, which is the whole point
  // of the server owning it; a few microtask turns is enough to let it finish.
  for (let index = 0; index < 20; index++) await Promise.resolve()
  await Bun.sleep(5)
}

test("two messages in a row queue and run in the order they were sent", async () => {
  const { chat, turns } = await harness()
  const session = await chat.create()

  await chat.send(session.id, "first")
  await chat.send(session.id, "second")
  await settle()

  // Not an error and not interleaved: a trader who types twice gets two answers,
  // in the order they asked.
  expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"])
  const detail = await chat.detail(session.id)
  expect(detail.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
    "USER:first",
    "ASSISTANT:answer to first",
    "USER:second",
    "ASSISTANT:answer to second",
  ])
  expect(detail.messages.every((message) => message.status !== "QUEUED")).toBe(true)
})

test("the second question sees the first exchange as history", async () => {
  const { chat, turns } = await harness()
  const session = await chat.create()

  await chat.send(session.id, "first")
  await settle()
  await chat.send(session.id, "second")
  await settle()

  // The question itself is passed separately, so it must not also appear in the
  // history — that would ask the model to answer the same thing twice.
  expect(turns[1]?.history.map((record) => (record as { role: string }).role)).toEqual([
    "user",
    "assistant",
  ])
})

test("stores a rolling checkpoint without removing the visible transcript", async () => {
  const summary: ChatRecord = { role: "user", content: "<conversation-summary>first exchange</conversation-summary>", timestamp: 3 }
  const compaction: ChatCompactionRunner = {
    history: (context) => context.records.map((entry) => entry.record as ChatRecord),
    compact: async (input) => {
      const last = input.context.records.at(-1)
      if (!last) return null
      return {
        checkpoint: {
          sessionId: input.sessionId,
          summary: "first exchange",
          compactedThroughSeq: last.seq,
          firstKeptSeq: null,
          tokensBefore: 100,
          createdAt: 3,
        },
        history: [summary],
      }
    },
  }
  const { chat, store, turns } = await harness({ compaction })
  const session = await chat.create()

  await chat.send(session.id, "first")
  await settle()
  await chat.send(session.id, "second")
  await settle()

  expect(turns[1]?.history).toEqual([summary])
  expect((await store.context(session.id)).compaction?.summary).toBe("first exchange")
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "first",
    "answer to first",
    "second",
    "answer to second",
  ])
})

test("manually compacts a settled chat without changing its transcript", async () => {
  const forceCalls: boolean[] = []
  const compaction: ChatCompactionRunner = {
    history: (context) => context.records.map((entry) => entry.record as ChatRecord),
    compact: async (input) => {
      forceCalls.push(input.force === true)
      if (!input.force) return null
      const last = input.context.records.at(-1)
      if (!last) return null
      return {
        checkpoint: {
          sessionId: input.sessionId,
          summary: "manual checkpoint",
          compactedThroughSeq: last.seq,
          firstKeptSeq: null,
          tokensBefore: 24_000,
          createdAt: 5,
        },
        history: [],
      }
    },
  }
  const { chat, store } = await harness({ compaction })
  const session = await chat.create()
  await chat.send(session.id, "keep this visible")
  await settle()

  const compacted = await chat.compact(session.id)

  expect(compacted).toEqual({ compacted: true, tokensBefore: 24_000 })
  expect(forceCalls).toEqual([false, true])
  expect((await store.context(session.id)).compaction?.summary).toBe("manual checkpoint")
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "keep this visible",
    "answer to keep this visible",
  ])
})

test("refuses manual compaction while the chat is answering", async () => {
  const { chat, finish } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "still running")
  await settle()

  const error = await chat.compact(session.id).catch((caught: unknown) => caught)

  expect(isProtocolError(error) && error.message).toContain("finish before compacting")
  finish()
  await settle()
})

test("compacts and retries one clean overflow without duplicating durable output", async () => {
  const summary: ChatRecord = { role: "user", content: "<conversation-summary>seed</conversation-summary>", timestamp: 4 }
  const forceCalls: boolean[] = []
  const compaction: ChatCompactionRunner = {
    history: (context) => context.records.map((entry) => entry.record as ChatRecord),
    compact: async (input) => {
      forceCalls.push(input.force === true)
      if (!input.force) return null
      const last = input.context.records.at(-1)
      if (!last) return null
      return {
        checkpoint: {
          sessionId: input.sessionId,
          summary: "seed",
          compactedThroughSeq: last.seq,
          firstKeptSeq: null,
          tokensBefore: 100,
          createdAt: 4,
        },
        history: [summary],
      }
    },
  }
  let continueAttempts = 0
  const { chat, turns } = await harness({
    compaction,
    run: async (turn) => {
      if (turn.prompt === "continue" && continueAttempts++ === 0) {
        return { completed: false, aborted: false, errorMessage: "context full", overflowed: true }
      }
      await turn.events.onMessage(reply(`answer to ${turn.prompt}`))
      return { completed: true, aborted: false, errorMessage: null }
    },
  })
  const session = await chat.create()

  await chat.send(session.id, "seed")
  await settle()
  await chat.send(session.id, "continue")
  await settle()

  expect(turns.map((turn) => turn.prompt)).toEqual(["seed", "continue", "continue"])
  expect(turns.at(-1)?.history).toEqual([summary])
  expect(forceCalls).toEqual([false, false, true])
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "seed",
    "answer to seed",
    "continue",
    "answer to continue",
  ])
})

test("an application event wakes its chat once with private model context", async () => {
  const policy = { mode: "CONFIRM_EACH_ORDER" as const }
  const resolved: Array<[string | null, string | null]> = []
  const { chat, store, turns } = await harness({
    executionPolicyForEvent: async (label, referenceId) => {
      resolved.push([label, referenceId])
      return policy
    },
  })
  const session = await chat.create()
  const event = {
    key: "price-alert:trigger-1",
    text: "ASELS crossed above 420 at 421.",
    prompt: "<market_monitor_triggered>continue the breakout review</market_monitor_triggered>",
    label: "loop",
    referenceId: "loop-1",
  }

  const queued = await chat.enqueueEvent(session.id, event)
  await settle()
  const duplicate = await chat.enqueueEvent(session.id, event)
  await settle()

  expect(queued?.role).toBe("APP_EVENT")
  expect(duplicate).toBeNull()
  expect(turns.map((turn) => turn.prompt)).toEqual([event.prompt])
  expect(turns[0]?.executionPolicy).toEqual(policy)
  expect(resolved).toEqual([["loop", "loop-1"]])
  const detail = await chat.detail(session.id)
  expect(detail.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
    `APP_EVENT:${event.text}`,
    `ASSISTANT:answer to ${event.prompt}`,
  ])
  expect((await store.records(session.id))[0]).toMatchObject({
    role: "user",
    content: event.prompt,
  })
})

test("a queued message can be taken back before its turn starts", async () => {
  const { chat, turns, frames, finish } = await harness({ auto: false })
  const session = await chat.create()

  await chat.send(session.id, "first")
  const second = await chat.send(session.id, "second")
  await settle()

  // The first turn is still running, so the second is still the trader's to cancel.
  expect(turns.map((turn) => turn.prompt)).toEqual(["first"])
  await chat.cancel(session.id, second.id)
  expect(frames).toContainEqual({ type: "chatMessageRemoved", sessionId: session.id, messageId: second.id })

  finish()
  await settle()

  // Cancelled means never asked, not asked and ignored.
  expect(turns.map((turn) => turn.prompt)).toEqual(["first"])
  const detail = await chat.detail(session.id)
  expect(detail.messages.some((message) => message.text === "second")).toBe(false)
})

test("a message already sent cannot be taken back", async () => {
  const { chat } = await harness()
  const session = await chat.create()
  const asked = await chat.send(session.id, "first")
  await settle()

  const failure = await chat.cancel(session.id, asked.id).then(
    () => null,
    (error: unknown) => error,
  )
  // It has been said. Reporting otherwise would tell the trader a question was
  // withdrawn when the model already answered it.
  expect(isProtocolError(failure) && failure.code).toBe("invalid_request")
})

test("stopping the reply in flight leaves the rest of the queue alone", async () => {
  const { chat, turns, finish } = await harness({ auto: false })
  const session = await chat.create()

  await chat.send(session.id, "first")
  await chat.send(session.id, "second")
  await settle()

  await chat.abort(session.id)
  // Stopping one answer is not clearing what is waiting: the turn ends, and the
  // next question still gets asked.
  finish({ completed: false, aborted: true })
  await settle()

  expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"])
  expect(turns[0]?.signal?.aborted).toBe(true)
})

test("a turn that fails leaves its question visible to send again", async () => {
  const { chat, frames, finish } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "first")
  await settle()

  finish({ completed: false, errorMessage: "the model gave up" })
  await settle()

  const detail = await chat.detail(session.id)
  const asked = detail.messages.find((message) => message.role === "USER")
  // Marked failed rather than silently consumed: the trader can send it again or
  // drop it, and either way they can see which one it was.
  expect(asked?.status).toBe("FAILED")
  expect(frames).toContainEqual({
    type: "chatRun",
    sessionId: session.id,
    runId: expect.any(String) as unknown as string,
    status: "failed",
    error: "the model gave up",
  })
})

test("a queue survives a restart of the server", async () => {
  const first = await harness({ connected: false })
  const session = await first.chat.create()
  await first.chat.send(session.id, "waiting")
  await settle()

  // Nothing ran, because there was no connection — and the message is still there
  // rather than having been failed away.
  expect(first.turns).toEqual([])
  expect((await first.chat.detail(session.id)).messages[0]?.status).toBe("QUEUED")

  // A second controller over the same store is what a restart looks like.
  const turns: ChatTurnOptions[] = []
  const restarted = new ChatController({
    store: first.store,
    agent: {
      run: async (turn) => {
        turns.push(turn)
        await turn.events.onMessage(reply(`answer to ${turn.prompt}`))
        return { completed: true, aborted: false, errorMessage: null }
      },
    },
    defaultChoice: async () => ({ providerId: "test-provider", modelId: "test-model", reasoning: "high" }),
    resolveModel: async (choice) => ({
      model: { id: choice.modelId, provider: choice.providerId } as never,
      reasoningEffort: choice.reasoning,
    }),
    requireModel: async () => {},
    broadcast: () => {},
    onError: () => {},
  })
  await restarted.start()
  await settle()

  expect(turns.map((turn) => turn.prompt)).toEqual(["waiting"])
  restarted.destroy()
  first.chat.destroy()
})

test("each session runs on its own model", async () => {
  // Two sessions on two providers is the point of choosing per session: a trader
  // comparing them must not have one answer for the other.
  const { chat, turns } = await harness()
  const first = await chat.create({ providerId: "anthropic", modelId: "claude-fable-5", reasoning: "max" })
  const second = await chat.create({ providerId: "groq", modelId: "llama-4", reasoning: null })

  await chat.send(first.id, "for the first")
  await chat.send(second.id, "for the second")
  await settle()

  expect(turns.map((turn) => [turn.prompt, turn.model.id, turn.reasoningEffort])).toEqual([
    ["for the first", "claude-fable-5", "max"],
    ["for the second", "llama-4", null],
  ])
})

test("changing the model applies from the next turn, not to the one already answered", async () => {
  const { chat, turns } = await harness()
  const session = await chat.create({ providerId: "groq", modelId: "llama-4", reasoning: null })
  await chat.send(session.id, "first")
  await settle()

  await chat.configure(session.id, { providerId: "anthropic", modelId: "claude-fable-5", reasoning: "high" })
  await chat.send(session.id, "second")
  await settle()

  expect(turns.map((turn) => turn.model.id)).toEqual(["llama-4", "claude-fable-5"])
})

test("a session with no model keeps its question until one is chosen", async () => {
  // Nothing is configured on a fresh install, so this is the first thing a trader
  // does. The question has to wait rather than fail and be lost.
  const { chat, store, frames, turns } = await harness({ connected: false })
  const session = await chat.create()
  await chat.send(session.id, "where is ASELS heading?")
  await settle()

  expect(turns).toEqual([])
  const detail = await store.get(session.id)
  expect(detail?.messages.map((message) => message.status)).toEqual(["QUEUED"])
  // And the reason reaches the trader rather than being swallowed.
  const failure = frames.find((frame) => frame.type === "chatRun" && frame.status === "failed")
  expect(failure && "error" in failure && failure.error).toContain("not connected")
})

test("different sessions answer at the same time", async () => {
  const { chat, turns } = await harness({ auto: false })
  const first = await chat.create()
  const second = await chat.create()

  await chat.send(first.id, "for the first")
  await chat.send(second.id, "for the second")
  await settle()

  // One at a time per conversation, but a slow answer in one must not hold up
  // another — they are separate conversations.
  expect(turns.map((turn) => turn.prompt).sort()).toEqual(["for the first", "for the second"])
  const sessions = await chat.list()
  expect(sessions.every((session) => session.running)).toBe(true)
})

test("generates a session title beside the first meaningful turn", async () => {
  const prompts: string[] = []
  const { chat } = await harness({
    generateTitle: async (message) => {
      prompts.push(message)
      return "Review ASELS closing direction"
    },
  })
  const session = await chat.create()
  expect(session.title).toMatch(/^New session - \d{4}-\d{2}-\d{2}T/u)

  await chat.send(session.id, "  Where is ASELS   heading   into the close?  ")
  await settle()
  await chat.send(session.id, "and THYAO?")
  await settle()

  expect(prompts).toEqual(["  Where is ASELS   heading   into the close?  "])
  expect((await chat.detail(session.id)).session.title).toBe("Review ASELS closing direction")
})

test("keeps the timestamp through small talk and retries on the next prompt", async () => {
  const prompts: string[] = []
  const { chat } = await harness({
    generateTitle: async (message) => {
      prompts.push(message)
      return message === "hello" ? null : "Analyze THYAO trend"
    },
  })
  const session = await chat.create()

  await chat.send(session.id, "hello")
  await settle()
  expect((await chat.detail(session.id)).session.title).toBe(session.title)

  await chat.send(session.id, "analyze THYAO")
  await settle()
  expect(prompts).toEqual(["hello", "analyze THYAO"])
  expect((await chat.detail(session.id)).session.title).toBe("Analyze THYAO trend")
})

test("a late automatic title cannot overwrite a manual rename", async () => {
  let finishTitle!: (title: string | null) => void
  const { chat, store } = await harness({
    generateTitle: async () => new Promise((resolve) => { finishTitle = resolve }),
  })
  const session = await chat.create()

  await chat.send(session.id, "Analyze ASELS")
  await settle()
  await store.rename(session.id, "My ASELS notes")
  finishTitle("Generated ASELS analysis")
  await settle()

  expect((await chat.detail(session.id)).session.title).toBe("My ASELS notes")
})

test("tells a client that attaches what is running, so it can catch up", async () => {
  const { chat, finish } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "first")
  await settle()

  const backlog = chat.backlog()
  expect(backlog[0]?.type).toBe("chatSessions")
  expect(backlog).toContainEqual({
    type: "chatRun",
    sessionId: session.id,
    runId: expect.any(String) as unknown as string,
    status: "running",
  })

  // And the partial is there to be read, which is what a late client renders.
  const detail = await chat.detail(session.id)
  expect(detail.partial?.runId).toEqual(expect.any(String))
  finish()
  await settle()
})

test("records subagents as live child sessions with their complete transcript", async () => {
  const { chat, frames } = await harness()
  const parent = await chat.create()
  const worker = await chat.subagentSessions.start({
    parentSessionId: parent.id,
    agent: "worker",
    task: "Inspect the XU100 trend",
    providerId: "test-provider",
    modelId: "test-model",
    reasoning: "high",
  })

  worker.onReasoning("Reading candles.")
  worker.onToolCall("get_candles")
  worker.onText("Trend is constructive.")
  await worker.onMessage(reply("Trend is constructive."))

  const running = await chat.children(parent.id)
  expect(running).toMatchObject([{
    id: worker.sessionId,
    parentSessionId: parent.id,
    agent: "worker",
    title: "Inspect the XU100 trend",
    running: true,
  }])
  const detail = await chat.detail(worker.sessionId)
  expect(detail.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
    "USER:Inspect the XU100 trend",
    "ASSISTANT:Trend is constructive.",
  ])
  expect(detail.partial).toMatchObject({ text: "Trend is constructive.", reasoning: "Reading candles." })

  await worker.finish(null)
  expect((await chat.children(parent.id))[0]?.running).toBe(false)
  expect(frames).toContainEqual(expect.objectContaining({
    type: "chatDelta",
    sessionId: worker.sessionId,
    toolName: "get_candles",
  }))

  const failure = await chat.send(worker.sessionId, "continue").then(
    () => null,
    (error: unknown) => error,
  )
  expect(isProtocolError(failure) && failure.code).toBe("invalid_request")
})

test("deleting a session stops the reply it was generating", async () => {
  const { chat, turns } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "first")
  await settle()

  await chat.remove(session.id)

  // A run left writing into a session that no longer exists is a run writing to
  // nothing.
  expect(turns[0]?.signal?.aborted).toBe(true)
  expect(await chat.list()).toEqual([])
})

test("reports an unknown session rather than inventing one", async () => {
  const { chat } = await harness()
  const failure = await chat.detail("nope").then(
    () => null,
    (error: unknown) => error,
  )
  expect(isProtocolError(failure) && failure.code).toBe("not_found")
})
