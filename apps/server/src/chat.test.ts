import { afterEach, expect, test } from "bun:test"
import type { ChatRecord, ChatTurnOptions, ChatTurnResult } from "@trbot/ai/chat.ts"
import type { ChatCompactionRunner } from "@trbot/ai/compaction.ts"
import { chatBlockText, type ChatMessageDraft } from "@trbot/chat/session.ts"
import { DrizzleChatSessionStore } from "@trbot/db/chat-store.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import { isProtocolError } from "@trbot/protocol/error.ts"
import { ChatController, type ChatRewindEffectManager, type ChatTurnRunner } from "./chat.ts"
import { modelRecord } from "@trbot/ai/compaction.ts"
import { testModel } from "@trbot/ai/model.test-fixture.ts"

const model = testModel("test-model")

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
  onTurnFailed?: (
    sessionId: string,
    event: { label: string | null; referenceId: string | null },
  ) => Promise<void>
  onTurnSettled?: (
    sessionId: string,
    event: { label: string | null; referenceId: string | null } | null,
  ) => Promise<void>
  rewindEffects?: ChatRewindEffectManager
  broadcast?: (frame: ChatFrame) => Promise<void> | void
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
    resolveModel: async (choice) => ({
      model: testModel(choice.modelId),
      reasoningEffort: choice.reasoning,
    }),
    generateTitle: options.generateTitle
      ? ({ message, signal }) => options.generateTitle!(message, signal)
      : undefined,
    requireModel: async () => {
      if (options.connected === false) throw new Error("test-provider is not connected")
    },
    rewindEffects: options.rewindEffects,
    onTurnFailed: options.onTurnFailed,
    onTurnSettled: options.onTurnSettled,
    broadcast: (frame) => {
      frames.push(frame)
      return options.broadcast?.(frame)
    },
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

test("claims the prompt before delivering the running state and starting the model", async () => {
  const running = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  let runningPromptMessageId: string | undefined
  const { chat, turns } = await harness({
    broadcast: (frame) => {
      if (frame.type !== "chatRun" || frame.status !== "running") return
      runningPromptMessageId = frame.promptMessageId
      running.resolve()
      return delivered.promise
    },
  })
  const session = await chat.create()

  const prompt = await chat.send(session.id, "wait for mobile")
  await running.promise
  expect(turns).toHaveLength(0)
  expect(runningPromptMessageId).toBe(prompt.id)
  expect((await chat.detail(session.id)).messages.find((message) => message.role === "USER")?.status).toBe("SENT")

  delivered.resolve()
  await settle()
  expect(turns).toHaveLength(1)
})

test("streams retry status and preserves it for run resync", async () => {
  const { chat, turns, frames, finish } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "wait through overload")
  await settle()
  const retry = {
    attempt: 1,
    maxAttempts: 5,
    message: "Provider is overloaded",
    reportedAt: 1_000,
    nextAt: 5_000,
  }

  turns[0]?.events.onReasoning("discarded attempt")
  turns[0]?.events.onRetry(retry)
  expect(frames.at(-1)).toMatchObject({
    type: "chatDelta",
    sessionId: session.id,
    seq: 2,
    retry,
  })
  expect((await chat.detail(session.id)).partial).toMatchObject({
    reasoning: "discarded attempt",
    retry: { ...retry, reportedAt: expect.any(Number) },
  })

  turns[0]?.events.onRetry(null)
  expect(frames.at(-1)).toMatchObject({ type: "chatDelta", seq: 3, retry: null })
  expect((await chat.detail(session.id)).partial).toMatchObject({ reasoning: "", retry: null })
  finish()
  await settle()
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
  expect(turns[1]?.history.map((record) => record.role)).toEqual([
    "user",
    "assistant",
  ])
})

test("stores a rolling checkpoint without removing the visible transcript", async () => {
  const summary: ChatRecord = { role: "user", content: "<conversation-summary>first exchange</conversation-summary>", timestamp: 3 }
  const compaction: ChatCompactionRunner = {
    history: (context) => context.compaction ? [summary] : context.records.map((entry) => modelRecord(entry.record)),
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
          tokensAfter: 20,
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
  expect((await store.context(session.id)).compaction?.summary).toBe("first exchange")
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

test("manual compaction keeps new prompts queued until its checkpoint is saved", async () => {
  const forceCalls: boolean[] = []
  const finishCompaction = Promise.withResolvers<void>()
  const compaction: ChatCompactionRunner = {
    history: (context) => context.records.map((entry) => modelRecord(entry.record)),
    compact: async (input) => {
      forceCalls.push(input.force === true)
      if (!input.force) return null
      await finishCompaction.promise
      const last = input.context.records.at(-1)
      if (!last) return null
      return {
        checkpoint: {
          sessionId: input.sessionId,
          summary: "manual checkpoint",
          compactedThroughSeq: last.seq,
          firstKeptSeq: null,
          tokensBefore: 24_000,
          tokensAfter: 2_400,
          createdAt: 5,
        },
        history: [],
      }
    },
  }
  const { chat, store, turns } = await harness({ compaction })
  const session = await chat.create()
  await chat.send(session.id, "keep this visible")
  await settle()

  const compacting = chat.compact(session.id)
  await settle()
  await chat.send(session.id, "wait behind compaction")
  await settle()

  expect(turns.map((turn) => turn.prompt)).toEqual(["keep this visible"])
  expect((await chat.detail(session.id)).messages.at(-1)?.status).toBe("QUEUED")

  finishCompaction.resolve()
  const compacted = await compacting
  await settle()

  expect(compacted).toEqual({ compacted: true, tokensBefore: 24_000, tokensAfter: 2_400 })
  expect(forceCalls).toEqual([false, false, true, false, false])
  expect((await store.context(session.id)).compaction?.summary).toBe("manual checkpoint")
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "keep this visible",
    "answer to keep this visible",
    "wait behind compaction",
    "answer to wait behind compaction",
  ])
})

test("refuses manual compaction while the chat is answering", async () => {
  const { chat, finish } = await harness({ auto: false })
  const session = await chat.create()
  await chat.send(session.id, "still running")
  await settle()

  const error = await chat.compact(session.id).catch((cause: unknown) => cause)

  expect(isProtocolError(error) && error.message).toContain("finish before compacting")
  finish()
  await settle()
})

test("compacts and retries one clean overflow without duplicating durable output", async () => {
  const summary: ChatRecord = { role: "user", content: "<conversation-summary>seed</conversation-summary>", timestamp: 4 }
  const forceCalls: boolean[] = []
  const compaction: ChatCompactionRunner = {
    history: (context) => context.records.map((entry) => modelRecord(entry.record)),
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
          tokensAfter: 20,
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
  expect(forceCalls).toEqual([false, false, false, true, false])
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "seed",
    "answer to seed",
    "continue",
    "answer to continue",
  ])
})

test("an application event wakes its chat once with private model context", async () => {
  const { chat, store, turns } = await harness()
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
  expect(turns[0]?.automationEvent).toEqual({ label: "loop", referenceId: "loop-1" })
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
    (cause: unknown) => cause,
  )
  // It has been said. Reporting otherwise would tell the trader a question was
  // withdrawn when the model already answered it.
  expect(isProtocolError(failure) && failure.code).toBe("invalid_request")
})

test("undo removes the chosen exchange and restores its prompt", async () => {
  const { chat, frames, turns } = await harness()
  const session = await chat.create()
  await chat.send(session.id, "first")
  await settle()
  await chat.send(session.id, "second")
  await settle()
  const target = (await chat.detail(session.id)).messages.find((message) => message.text === "second")

  const result = await chat.undo(session.id, target?.id ?? "")

  expect(result.prompt).toBe("second")
  expect(result.removedMessageIds).toHaveLength(2)
  expect(frames.filter((frame) => frame.type === "chatMessageRemoved").map((frame) => frame.messageId))
    .toEqual(expect.arrayContaining(result.removedMessageIds))
  expect((await chat.detail(session.id)).messages.map((message) => message.text)).toEqual([
    "first",
    "answer to first",
  ])

  await chat.send(session.id, "replacement")
  await settle()
  expect(turns[2]?.history.map((record) => record.role)).toEqual(["user", "assistant"])
})

test("previews recorded tool effects and optionally restores them before truncation", async () => {
  const reverted: string[][] = []
  const manager: ChatRewindEffectManager = {
    preview: async (effects) => effects.map((effect) => ({
      description: effect.description,
      reversible: effect.reversible,
    })),
    revert: async (_sessionId, effects) => {
      reverted.push(effects.map((effect) => effect.description))
      return { reverted: effects.map((effect) => effect.description), preserved: [] }
    },
  }
  const { chat } = await harness({
    rewindEffects: manager,
    run: async (turn) => {
      await turn.events.onMessage({
        message: {
          id: crypto.randomUUID(),
          role: "TOOL_RESULT",
          status: "COMPLETE",
          text: "monitor created",
          blocks: [chatBlockText("monitor created")],
          toolName: "create_market_monitor",
          toolCallId: "call-1",
          isError: false,
          errorMessage: null,
          usage: null,
          model: null,
          reasoning: null,
          elapsedMs: null,
          thinkingMs: null,
          createdAt: Date.now(),
        },
        record: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "create_market_monitor",
          content: [{ type: "text", text: "monitor created" }],
          isError: false,
          timestamp: Date.now(),
        },
        effects: [{
          kind: "MARKET_MONITOR",
          resourceId: "monitor-1",
          description: "Market monitor was created",
          reversible: true,
          before: null,
          after: { id: "monitor-1" },
        }],
      })
      return { completed: true, aborted: false, errorMessage: null }
    },
  })
  const session = await chat.create()
  const prompt = await chat.send(session.id, "watch this")
  await settle()

  expect(await chat.previewUndo(session.id, prompt.id)).toEqual({
    prompt: "watch this",
    effects: [{ description: "Market monitor was created", reversible: true }],
  })
  const result = await chat.undo(session.id, prompt.id, true)

  expect(reverted).toEqual([["Market monitor was created"]])
  expect(result.revertedEffects).toEqual(["Market monitor was created"])
  expect(result.preservedEffects).toEqual([])
  expect((await chat.detail(session.id)).messages).toEqual([])
})

test("undo waits until running and queued work has settled", async () => {
  const { chat, finish } = await harness({ auto: false })
  const session = await chat.create()
  const first = await chat.send(session.id, "first")
  await chat.send(session.id, "second")
  await settle()

  const error = await chat.undo(session.id, first.id).catch((cause: unknown) => cause)

  expect(isProtocolError(error) && error.message).toContain("finish before undoing")
  finish()
  await settle()
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

test("stopping from a subagent transcript aborts its owning turn", async () => {
  const { chat, turns, finish } = await harness({ auto: false })
  const parent = await chat.create()
  const prompt = await chat.send(parent.id, "delegate this")
  await settle()
  const worker = await chat.subagentSessions.start({
    parentSessionId: parent.id,
    parentToolCallId: null,
    agent: "worker",
    task: "inspect the market",
    providerId: "test-provider",
    modelId: "test-model",
    reasoning: "high",
  })
  expect((await chat.detail(worker.sessionId)).session.parentPromptMessageId).toBe(prompt.id)

  await chat.abort(worker.sessionId)

  expect(turns[0]?.signal?.aborted).toBe(true)
  await worker.finish(null)
  finish({ completed: false, aborted: true })
  await settle()
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
  const failed = frames.find((frame) => frame.type === "chatRun" && frame.status === "failed")
  expect(failed).toMatchObject({
    type: "chatRun",
    sessionId: session.id,
    status: "failed",
    error: "the model gave up",
  })
  expect(failed?.type === "chatRun" ? failed.runId : null).toEqual(expect.any(String))
})

test("reports a failed application wake-up to its automation owner", async () => {
  const failed: Array<{
    sessionId: string
    event: { label: string | null; referenceId: string | null }
  }> = []
  const { chat, finish } = await harness({
    auto: false,
    onTurnFailed: async (sessionId, event) => { failed.push({ sessionId, event }) },
  })
  const session = await chat.create()
  await chat.enqueueEvent(session.id, {
    key: "goal-event-1",
    label: "goal",
    referenceId: "goal-1",
    text: "Continuing goal",
    prompt: "Continue the goal",
  })
  await settle()

  finish({ completed: false, errorMessage: "provider timed out" })
  await settle()

  expect(failed).toEqual([{
    sessionId: session.id,
    event: { label: "goal", referenceId: "goal-1" },
  }])
})

test("moves a disconnected goal wake-up into automation backoff", async () => {
  const failed: string[] = []
  const { chat } = await harness({
    connected: false,
    onTurnFailed: async (_sessionId, event) => { failed.push(event.referenceId ?? "") },
  })
  const session = await chat.create()
  await chat.enqueueEvent(session.id, {
    key: "goal-disconnected-1",
    label: "goal",
    referenceId: "goal-1",
    text: "Continuing goal",
    prompt: "Continue the goal",
  })
  await settle()

  expect(failed).toEqual(["goal-1"])
  expect((await chat.detail(session.id)).messages.find((message) => message.role === "APP_EVENT")?.status).toBe("FAILED")
})

test("keeps a turn running until its automation settlement finishes", async () => {
  let controller: ChatController | null = null
  let runningDuringSettlement = false
  const built = await harness({
    onTurnSettled: async (sessionId) => {
      runningDuringSettlement = (await controller?.detail(sessionId))?.session.running ?? false
    },
  })
  controller = built.chat
  const session = await built.chat.create()

  await built.chat.send(session.id, "continue the goal")
  await settle()

  expect(runningDuringSettlement).toBe(true)
  expect((await built.chat.detail(session.id)).session.running).toBe(false)
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
      model,
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
  const running = backlog.find((frame) => frame.type === "chatRun" && frame.status === "running")
  expect(running).toMatchObject({ type: "chatRun", sessionId: session.id, status: "running" })
  expect(running?.type === "chatRun" ? running.runId : null).toEqual(expect.any(String))

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
    parentToolCallId: null,
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
  const retry = {
    attempt: 1,
    maxAttempts: 5,
    message: "Provider is overloaded",
    reportedAt: 1_000,
    nextAt: 5_000,
  }
  worker.onRetry(retry)

  const running = await chat.children(parent.id)
  expect(running).toMatchObject([{
    id: worker.sessionId,
    parentSessionId: parent.id,
    parentPromptMessageId: null,
    agent: "worker",
    title: "Inspect the XU100 trend",
    running: true,
  }])
  const detail = await chat.detail(worker.sessionId)
  expect(detail.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
    "USER:Inspect the XU100 trend",
    "ASSISTANT:Trend is constructive.",
  ])
  expect(detail.partial).toMatchObject({
    text: "Trend is constructive.",
    reasoning: "Reading candles.",
    retry: { ...retry, reportedAt: expect.any(Number) },
  })

  worker.onRetry(null)
  expect((await chat.detail(worker.sessionId)).partial).toMatchObject({ reasoning: "", retry: null })

  await worker.finish(null)
  expect((await chat.children(parent.id))[0]?.running).toBe(false)
  expect(frames).toContainEqual(expect.objectContaining({
    type: "chatDelta",
    sessionId: worker.sessionId,
    toolName: "get_candles",
  }))
  expect(frames).toContainEqual(expect.objectContaining({
    type: "chatDelta",
    sessionId: worker.sessionId,
    retry,
  }))

  const failure = await chat.send(worker.sessionId, "continue").then(
    () => null,
    (cause: unknown) => cause,
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
    (cause: unknown) => cause,
  )
  expect(isProtocolError(failure) && failure.code).toBe("not_found")
})
