import type { ChatRecord, ChatTurnModel, ChatTurnOptions, ChatTurnResult } from "@trbot/ai/chat.ts"
import { modelRecord, type ChatCompactionRunner } from "@trbot/ai/compaction.ts"
import type { SubagentSessionRecorder, SubagentSessionRun } from "@trbot/ai/subagent.ts"
import {
  chatBlockText,
  chatSessionTitle,
  defaultChatSessionTitle,
  isDefaultChatSessionTitle,
  type ChatApplicationEvent,
  type ChatCompactionReport,
  type ChatModelChoice,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatPartial,
  type ChatRetryStatus,
  type ChatSession,
  type ChatSessionDetail,
  type ChatSessionStore,
  type ChatToolEffect,
  type ChatUndoEffect,
  type ChatUndoPreview,
  type ChatUndoResult,
} from "@trbot/chat/session.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

/**
 * Whatever runs one exchange with the model. Narrower than the agent itself so the
 * controller's own behaviour — queueing, cancelling, restarting — can be tested
 * without a model.
 */
export interface ChatTurnRunner {
  run(turn: ChatTurnOptions): Promise<ChatTurnResult>
}

export interface ChatRewindEffectManager {
  preview(effects: ChatToolEffect[]): Promise<ChatUndoEffect[]>
  revert(sessionId: string, effects: ChatToolEffect[]): Promise<{
    reverted: string[]
    preserved: string[]
  }>
}

export interface ChatControllerOptions {
  store: ChatSessionStore
  agent: ChatTurnRunner
  /** Hidden rolling summaries for long conversations. Omitted by narrow controller tests. */
  compaction?: ChatCompactionRunner
  /**
   * The model a new session starts on, or null when nobody has chosen one.
   *
   * Read per session rather than held, because a trader can change it between one
   * session and the next.
   */
  defaultChoice: () => Promise<ChatModelChoice | null>
  /** Resolves a stored choice into something a turn can run on. */
  resolveModel: (choice: ChatModelChoice) => Promise<ChatTurnModel>
  /** A separate, tool-free model call that names an eligible root conversation. */
  generateTitle?: (input: {
    message: string
    model: ChatTurnModel
    signal: AbortSignal
  }) => Promise<string | null>
  /** Refused before a run starts, so an unusable model is an ordinary error. */
  requireModel: (choice: ChatModelChoice | null) => Promise<void>
  /** Runs automation only after the complete agent/tool lifecycle has settled. */
  onTurnSettled?: (
    sessionId: string,
    event: { label: string | null; referenceId: string | null } | null,
  ) => Promise<void>
  /** Lets durable automations recover when their application-owned turn fails. */
  onTurnFailed?: (
    sessionId: string,
    event: { label: string | null; referenceId: string | null },
  ) => Promise<void>
  rewindEffects?: ChatRewindEffectManager
  broadcast: (frame: ChatFrame) => Promise<void> | void
  onError: (cause: unknown) => void
  now?: () => number
}

/** A reply being generated right now. */
interface ChatRun {
  runId: string
  promptMessageId: string
  seq: number
  text: string
  reasoning: string
  retry: ChatRetryStatus | null
  /** Child runs inherit their parent's signal and have no independent controller. */
  controller?: AbortController
}

/**
 * Owns every chat conversation: what is queued, what is running, and what has
 * been said.
 *
 * Runs live here rather than in the request that asked for one, so a reply keeps
 * being generated and stored when the terminal switches tabs, drops its socket, or
 * quits — and so every attached client sees the same conversation. That is the same
 * reason the stop and alert monitors are here.
 *
 * Sending never fails for being busy. A message is queued, and each session works
 * through its own queue one turn at a time while different sessions run at once. A
 * queued message can be taken back until its turn starts, which is what makes a
 * queue a queue rather than a hidden buffer: a trader who changes their mind before
 * the model gets there can simply remove it.
 */
export class ChatController {
  private readonly runs = new Map<string, ChatRun>()
  private readonly titleRuns = new Map<string, AbortController>()
  /** The last known session list, so a socket opening costs no query. */
  private sessions: ChatSession[] = []
  /** Sessions whose queue is being worked through, so a second send does not start a race. */
  private readonly draining = new Set<string>()
  /** Manual compaction occupies the same per-session slot as a running turn. */
  private readonly manualCompactions = new Set<string>()
  /** Prevents a just-aborted parent or child from writing after its rows were removed. */
  private readonly removedSessionIds = new Set<string>()
  /** Serializes destructive transcript changes for one conversation. */
  private readonly undoing = new Set<string>()
  private readonly now: () => number
  private destroyed = false

  constructor(private readonly options: ChatControllerOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Reads what is stored and picks up anything a previous run of the server left
   * queued.
   *
   * A queue that only drained while the process that filled it stayed alive would
   * not be a queue at all — a trader who queued three questions and restarted the
   * server would find them waiting forever.
   */
  async start(): Promise<void> {
    this.sessions = await this.options.store.list()
    for (const sessionId of await this.options.store.queuedSessionIds()) {
      this.drain(sessionId)
    }
  }

  async list(): Promise<ChatSession[]> {
    this.sessions = await this.options.store.list()
    return this.sessions.map((session) => this.withRunState(session))
  }

  /** Rechecks an existing durable queue, typically after an external dependency recovers. */
  resumeQueue(sessionId: string): void {
    this.drain(sessionId)
  }

  async create(choice?: ChatModelChoice): Promise<ChatSession> {
    const now = this.now()
    // A session records the model it was started on, so a transcript still says what
    // wrote it after the default moves on. With nothing chosen it records nothing and
    // asks for a choice when the trader first sends.
    const chosen = choice ?? (await this.options.defaultChoice())
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: defaultChatSessionTitle(now),
      parentSessionId: null,
      parentPromptMessageId: null,
      parentToolCallId: null,
      agent: null,
      model: chosen?.modelId ?? "",
      provider: chosen?.providerId ?? null,
      reasoning: chosen?.reasoning ?? null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      queued: 0,
      running: false,
    }
    await this.options.store.create(session)
    await this.announceSessions()
    return session
  }

  async children(parentSessionId: string): Promise<ChatSession[]> {
    await this.detail(parentSessionId)
    return (await this.options.store.listChildren(parentSessionId)).map((session) => this.withRunState(session))
  }

  /**
   * Opens a durable child transcript before a worker starts producing output.
   *
   * The worker still runs inside the parent's tool call; this recorder only gives
   * that isolated context the same persistence and live stream as a normal chat.
   */
  readonly subagentSessions: SubagentSessionRecorder = {
    start: (input) => this.startSubagentSession(input),
  }

  /**
   * Points a session at a different model.
   *
   * Takes effect from the next turn: a reply being generated now keeps the model it
   * started on, because switching mid-answer would leave half a message from each.
   */
  async configure(sessionId: string, choice: ChatModelChoice): Promise<ChatSession> {
    await this.options.store.configure(sessionId, choice)
    await this.announceSessions()
    const detail = await this.options.store.get(sessionId)
    if (!detail) throw new ProtocolError("not_found", "No such chat session")
    return this.withRunState(detail.session)
  }

  async detail(sessionId: string, topLevelLimit?: number): Promise<ChatSessionDetail> {
    const detail = await this.options.store.get(sessionId, topLevelLimit)
    if (!detail) throw new ProtocolError("not_found", "No such chat")
    return {
      ...detail,
      session: this.withRunState(detail.session),
      partial: this.partialOf(sessionId),
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.detail(sessionId)
    // A session being deleted under a running reply would leave the run writing
    // to rows that are gone, so the run is stopped first.
    const removed = await this.sessionTreeIds(sessionId)
    for (const id of removed) {
      this.removedSessionIds.add(id)
      this.abortRun(id)
      this.titleRuns.get(id)?.abort()
      this.titleRuns.delete(id)
      this.runs.delete(id)
    }
    await this.options.store.delete(sessionId)
    await this.announceSessions()
  }

  /**
   * Queues what the trader wrote and makes sure the session is being worked through.
   *
   * The message is persisted before anything else happens, so a server that dies
   * between the request and the model still has it, and the transcript shows what
   * was asked rather than losing it.
   */
  async send(sessionId: string, text: string): Promise<ChatMessage> {
    const detail = await this.detail(sessionId)
    if (detail.session.parentSessionId) {
      throw new ProtocolError("invalid_request", "Subagent sessions are read-only")
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "USER",
      status: "QUEUED",
      text,
      blocks: [chatBlockText(text)],
      toolName: null,
      toolCallId: null,
      isError: false,
      errorMessage: null,
      usage: null,
      model: null,
      reasoning: null,
      elapsedMs: null,
      thinkingMs: null,
      createdAt: this.now(),
    }
    await this.options.store.append(sessionId, { message, record: userRecord(message) })

    this.options.broadcast({ type: "chatMessage", sessionId, message })
    await this.announceSessions()
    this.drain(sessionId)
    return message
  }

  /**
   * Wakes a conversation with an application-owned event.
   *
   * The visible fact stays separate from the model prompt, which also carries
   * the continuation the agent stored when it created the watch. `key` is the
   * durable boundary: recovery may retry this call, but one crossing gets one turn.
   */
  async enqueueEvent(sessionId: string, event: ChatApplicationEvent): Promise<ChatMessage | null> {
    await this.detail(sessionId)
    const createdAt = this.now()
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "APP_EVENT",
      status: "QUEUED",
      text: event.text,
      blocks: [chatBlockText(event.text)],
      toolName: event.label ?? null,
      toolCallId: event.referenceId ?? null,
      isError: false,
      errorMessage: null,
      usage: null,
      model: null,
      reasoning: null,
      elapsedMs: null,
      thinkingMs: null,
      createdAt,
    }
    const appended = await this.options.store.appendEvent(sessionId, {
      message,
      record: { role: "user", content: event.prompt, timestamp: createdAt },
    }, event.key)
    if (!appended) return null

    this.options.broadcast({ type: "chatMessage", sessionId, message })
    await this.announceSessions()
    this.drain(sessionId)
    return message
  }

  /** Takes back a message that has not had its turn yet. */
  async cancel(sessionId: string, messageId: string): Promise<void> {
    const detail = await this.detail(sessionId)
    const message = detail.messages.find((entry) => entry.id === messageId)
    if (!message) throw new ProtocolError("not_found", "No such message")
    if (message.status !== "QUEUED") {
      throw new ProtocolError("invalid_request", "That message has already been sent")
    }
    await this.options.store.remove(messageId)
    this.options.broadcast({ type: "chatMessageRemoved", sessionId, messageId })
    await this.announceSessions()
  }

  /** Describes tool mutations that would be affected without changing the chat. */
  async previewUndo(sessionId: string, messageId: string): Promise<ChatUndoPreview> {
    const { target } = await this.rewindTarget(sessionId, messageId)
    const effects = await this.options.store.effectsFrom(sessionId, messageId)
    const preview = this.options.rewindEffects
      ? await this.options.rewindEffects.preview(effects)
      : effects.map((effect) => ({ description: effect.description, reversible: false }))
    return { prompt: target.text, effects: preview }
  }

  /** Returns to just before a completed trader prompt, optionally restoring safe app effects. */
  async undo(sessionId: string, messageId: string, revertEffects = false): Promise<ChatUndoResult> {
    if (this.undoing.has(sessionId)) {
      throw new ProtocolError("invalid_request", "This chat is already being undone")
    }
    this.undoing.add(sessionId)
    try {
      const { target } = await this.rewindTarget(sessionId, messageId)
      const effects = await this.options.store.effectsFrom(sessionId, messageId)
      const effectResult = revertEffects && this.options.rewindEffects
        ? await this.options.rewindEffects.revert(sessionId, effects)
        : { reverted: [], preserved: effects.map((effect) => effect.description) }

      this.titleRuns.get(sessionId)?.abort()
      this.titleRuns.delete(sessionId)
      const removedMessageIds = await this.options.store.rewindFrom(sessionId, messageId)
      if (!removedMessageIds.includes(messageId)) {
        throw new ProtocolError("not_found", "No such message")
      }
      for (const removedMessageId of removedMessageIds) {
        this.options.broadcast({ type: "chatMessageRemoved", sessionId, messageId: removedMessageId })
      }
      await this.announceSessions()
      return {
        prompt: target.text,
        removedMessageIds,
        revertedEffects: effectResult.reverted,
        preservedEffects: effectResult.preserved,
      }
    } finally {
      this.undoing.delete(sessionId)
    }
  }

  private async rewindTarget(
    sessionId: string,
    messageId: string,
  ): Promise<{ target: ChatMessage }> {
    const detail = await this.detail(sessionId)
    if (detail.session.parentSessionId) {
      throw new ProtocolError("invalid_request", "Subagent sessions are read-only")
    }
    if (detail.session.running || detail.session.queued > 0) {
      throw new ProtocolError("invalid_request", "Wait for this chat to finish before undoing it")
    }
    const target = detail.messages.find((message) => message.id === messageId)
    if (!target) throw new ProtocolError("not_found", "No such message")
    if (target.role !== "USER" || target.status === "QUEUED") {
      throw new ProtocolError("invalid_request", "Choose a completed user prompt to undo")
    }
    return { target }
  }

  /**
   * Stops the reply being generated now, keeping what it produced.
   *
   * The rest of the queue is left alone: stopping one answer is not the same as
   * clearing what is waiting, and a trader who meant the second has `cancel`.
   */
  async abort(sessionId: string): Promise<void> {
    let session = (await this.detail(sessionId)).session
    for (;;) {
      const run = this.runs.get(session.id)
      if (run?.controller) {
        run.controller.abort()
        return
      }
      if (!session.parentSessionId) return
      session = (await this.detail(session.parentSessionId)).session
    }
  }

  /** Forces a fresh rolling summary without adding anything to the conversation. */
  async compact(sessionId: string): Promise<ChatCompactionReport> {
    const detail = await this.detail(sessionId)
    if (detail.session.running || detail.session.queued > 0 || this.manualCompactions.has(sessionId)) {
      throw new ProtocolError("invalid_request", "Wait for this chat to finish before compacting it")
    }
    if (!this.options.compaction) {
      throw new ProtocolError("invalid_request", "Chat compaction is unavailable")
    }

    this.manualCompactions.add(sessionId)
    this.draining.add(sessionId)
    await this.announceSessions()
    try {
      const choice = choiceOf(detail.session)
      if (!choice) throw new ProtocolError("invalid_request", "Choose a chat model before compacting this session")
      await this.options.requireModel(choice)
      const turnModel = await this.options.resolveModel(choice)
      const compacted = await this.options.compaction.compact({
        sessionId,
        model: turnModel.model,
        context: await this.options.store.context(sessionId),
        prompt: "",
        force: true,
      })
      if (!compacted) return { compacted: false, tokensBefore: null }
      await this.options.store.saveCompaction(compacted.checkpoint)
      await this.options.broadcast({ type: "chatCompacted", sessionId, compaction: compacted.checkpoint })
      return {
        compacted: true,
        tokensBefore: compacted.checkpoint.tokensBefore,
        tokensAfter: compacted.checkpoint.tokensAfter ?? compacted.checkpoint.tokensBefore,
      }
    } finally {
      this.manualCompactions.delete(sessionId)
      this.draining.delete(sessionId)
      await this.announceSessions()
      this.drain(sessionId)
    }
  }

  destroy(): void {
    this.destroyed = true
    for (const run of this.runs.values()) run.controller?.abort()
    for (const title of this.titleRuns.values()) title.abort()
    this.runs.clear()
    this.titleRuns.clear()
  }

  /**
   * Frames a client needs on attach to know where every conversation stands.
   *
   * Read from the list this controller already keeps rather than from storage: a
   * socket opening is not a reason to query, and every change has already been
   * broadcast. The `running` frames are what tell a terminal that arrived mid-reply
   * to fetch the session and pick up the partial.
   */
  backlog(): ChatFrame[] {
    const frames: ChatFrame[] = [
      { type: "chatSessions", sessions: this.sessions.map((session) => this.withRunState(session)) },
    ]
    for (const [sessionId, run] of this.runs) {
      frames.push({
        type: "chatRun",
        sessionId,
        runId: run.runId,
        status: "running",
        promptMessageId: run.promptMessageId,
      })
    }
    return frames
  }

  private async startSubagentSession(
    input: Parameters<SubagentSessionRecorder["start"]>[0],
  ): Promise<SubagentSessionRun> {
    await this.detail(input.parentSessionId)
    const now = this.now()
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: chatSessionTitle(input.task),
      parentSessionId: input.parentSessionId,
      parentPromptMessageId: this.runs.get(input.parentSessionId)?.promptMessageId ?? null,
      parentToolCallId: input.parentToolCallId,
      agent: input.agent,
      model: input.modelId,
      provider: input.providerId,
      reasoning: input.reasoning,
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      queued: 0,
      running: true,
    }
    const task: ChatMessage = {
      id: crypto.randomUUID(),
      role: "USER",
      status: "SENT",
      text: input.task,
      blocks: [chatBlockText(input.task)],
      toolName: null,
      toolCallId: null,
      isError: false,
      errorMessage: null,
      usage: null,
      model: null,
      reasoning: null,
      elapsedMs: null,
      thinkingMs: null,
      createdAt: now,
    }
    const runId = crypto.randomUUID()
    const run: ChatRun = { runId, promptMessageId: task.id, seq: 0, text: "", reasoning: "", retry: null }

    await this.options.store.create(session)
    await this.options.store.append(session.id, { message: task, record: userRecord(task) })
    this.runs.set(session.id, run)
    this.options.broadcast({ type: "chatMessage", sessionId: session.id, message: task })
    this.options.broadcast({
      type: "chatRun",
      sessionId: session.id,
      runId,
      status: "running",
      promptMessageId: task.id,
    })

    return {
      sessionId: session.id,
      onText: (delta) => this.recordSubagentDelta(session.id, runId, { text: delta }),
      onReasoning: (delta) => this.recordSubagentDelta(session.id, runId, { reasoning: delta }),
      onToolCall: (toolName) => this.recordSubagentDelta(session.id, runId, { toolName }),
      onRetry: (retry) => this.recordSubagentDelta(session.id, runId, { retry }),
      onMessage: (draft) => this.persist(session.id, draft),
      finish: async (error) => {
        if (this.runs.get(session.id)?.runId === runId) this.runs.delete(session.id)
        const frame: Extract<ChatFrame, { type: "chatRun" }> = {
          type: "chatRun",
          sessionId: session.id,
          runId,
          status: error ? "failed" : "done",
          promptMessageId: task.id,
        }
        if (error) frame.error = error
        this.options.broadcast(frame)
      },
    }
  }

  private recordSubagentDelta(
    sessionId: string,
    runId: string,
    delta: { text?: string; reasoning?: string; toolName?: string; retry?: ChatRetryStatus | null },
  ): void {
    const run = this.runs.get(sessionId)
    if (!run || run.runId !== runId) return
    if (delta.text) run.text += delta.text
    if (delta.reasoning) run.reasoning += delta.reasoning
    if (delta.retry !== undefined) {
      run.retry = delta.retry
      if (delta.retry === null) run.reasoning = ""
    }
    run.seq += 1
    this.options.broadcast({
      type: "chatDelta",
      sessionId,
      runId,
      seq: run.seq,
      ...delta,
    })
  }

  private abortRun(sessionId: string): void {
    this.runs.get(sessionId)?.controller?.abort()
  }

  /**
   * Works through one session's queue, one turn at a time.
   *
   * Deliberately not awaited by its caller: a send returns as soon as the message
   * is safely queued, and the turn it triggers outlives that request.
   */
  private drain(sessionId: string): void {
    if (this.draining.has(sessionId) || this.destroyed) return
    this.draining.add(sessionId)
    void this.drainQueue(sessionId).finally(() => this.draining.delete(sessionId))
  }

  private async drainQueue(sessionId: string): Promise<void> {
    while (!this.destroyed) {
      const detail = await this.options.store.get(sessionId)
      if (!detail) return
      const next = detail.messages.find((message) => message.status === "QUEUED")
      if (!next) return

      const choice = choiceOf(detail.session)
      if (!choice) {
        this.options.broadcast({
          type: "chatRun",
          sessionId,
          runId: next.id,
          status: "failed",
          promptMessageId: next.id,
          error: "Choose a model before sending a message",
        })
        return
      }
      try {
        await this.options.requireModel(choice)
      } catch (error) {
        const message = errorMessage(error)
        // User input waits for reconnection rather than being marked failed. A goal
        // wake-up instead enters its durable retry schedule so it cannot strand the goal.
        this.options.broadcast({
          type: "chatRun",
          sessionId,
          runId: next.id,
          status: "failed",
          promptMessageId: next.id,
          error: message,
        })
        if (next.role === "APP_EVENT" && next.toolName === "goal" && this.options.onTurnFailed) {
          await this.options.store.setStatus(next.id, "FAILED")
          try {
            await this.options.onTurnFailed(sessionId, { label: next.toolName, referenceId: next.toolCallId })
          } catch (failure) {
            this.options.onError(failure)
          }
          await this.announceSessions()
          continue
        }
        return
      }

      await this.runTurn(sessionId, next, choice, detail.session.title)
    }
  }

  private async runTurn(
    sessionId: string,
    asked: ChatMessage,
    choice: ChatModelChoice,
    sessionTitle: string,
  ): Promise<void> {
    const run: ChatRun = {
      runId: crypto.randomUUID(),
      promptMessageId: asked.id,
      seq: 0,
      text: "",
      reasoning: "",
      retry: null,
      controller: new AbortController(),
    }
    this.runs.set(sessionId, run)
    const automationEvent = asked.role === "APP_EVENT"
      ? { label: asked.toolName, referenceId: asked.toolCallId }
      : null

    let result: ChatTurnResult
    try {
      const turnModel = await this.options.resolveModel(choice)
      const prompt = await this.options.store.inputText(asked.id) ?? asked.text
      // Read while the question is still queued, so the context is what came before
      // it and the model is not handed the same question twice.
      let modelContext = await this.options.store.context(sessionId)
      let history = this.options.compaction
        ? this.options.compaction.history(modelContext)
        : modelContext.records.map((entry) => modelRecord(entry.record))

      // Claim the queued input before announcing the run. A client resyncs when
      // it sees that announcement, so the durable status must already say this
      // prompt is being handled rather than still being cancellable.
      await this.options.store.markSent(asked.id)
      await this.options.broadcast({
        type: "chatRun",
        sessionId,
        runId: run.runId,
        status: "running",
        promptMessageId: asked.id,
      })
      await this.announceSessions()

      if (this.options.compaction) {
        try {
          const compacted = await this.options.compaction.compact({
            sessionId,
            model: turnModel.model,
            context: modelContext,
            prompt,
            signal: run.controller!.signal,
          })
          if (compacted) {
            await this.options.store.saveCompaction(compacted.checkpoint)
            await this.options.broadcast({ type: "chatCompacted", sessionId, compaction: compacted.checkpoint })
            const refreshed = await this.options.store.context(sessionId)
            modelContext = {
              ...refreshed,
              records: refreshed.records.filter((entry) => entry.id !== asked.id),
            }
            history = compacted.history
          }
        } catch (error) {
          // Predictive compaction is maintenance, not the user's turn. If it fails,
          // preserve the original request and let overflow recovery make one last try.
          this.options.onError(error)
        }
      }

      if (asked.role === "USER") {
        this.maybeStartTitleGeneration(sessionId, sessionTitle, asked.text, turnModel)
      }
      let recoveryAttempted = false
      for (;;) {
        result = await this.options.agent.run({
          model: turnModel.model,
          reasoningEffort: turnModel.reasoningEffort,
          history,
          prompt,
          chatSessionId: sessionId,
          automationEvent: automationEvent ?? undefined,
          signal: run.controller!.signal,
          events: {
            onText: (delta) => {
              run.text += delta
              run.seq += 1
              this.options.broadcast({
                type: "chatDelta",
                sessionId,
                runId: run.runId,
                seq: run.seq,
                text: delta,
              })
            },
            onReasoning: (delta) => {
              run.reasoning += delta
              run.seq += 1
              this.options.broadcast({
                type: "chatDelta",
                sessionId,
                runId: run.runId,
                seq: run.seq,
                reasoning: delta,
              })
            },
            onToolCall: async (name) => {
              run.seq += 1
              await this.options.broadcast({
                type: "chatDelta",
                sessionId,
                runId: run.runId,
                seq: run.seq,
                toolName: name,
              })
            },
            onRetry: (retry) => {
              run.retry = retry
              if (retry === null) run.reasoning = ""
              run.seq += 1
              this.options.broadcast({
                type: "chatDelta",
                sessionId,
                runId: run.runId,
                seq: run.seq,
                retry,
              })
            },
            onMessage: (draft) => this.persist(sessionId, draft),
          },
        })
        if (!result.overflowed || recoveryAttempted || !this.options.compaction) break
        recoveryAttempted = true
        let compacted = null
        try {
          compacted = await this.options.compaction.compact({
            sessionId,
            model: turnModel.model,
            context: modelContext,
            prompt,
            signal: run.controller!.signal,
            force: true,
          })
        } catch (error) {
          this.options.onError(error)
        }
        if (!compacted) break
        await this.options.store.saveCompaction(compacted.checkpoint)
        await this.options.broadcast({ type: "chatCompacted", sessionId, compaction: compacted.checkpoint })
        history = compacted.history
      }

      // Compact a completed over-threshold response in place instead of discarding
      // and retrying it. The next turn then starts from the new checkpoint.
      if (result.completed && this.options.compaction) {
        try {
          const settledContext = await this.options.store.context(sessionId)
          const compacted = await this.options.compaction.compact({
            sessionId,
            model: turnModel.model,
            context: settledContext,
            prompt: "",
            signal: run.controller!.signal,
          })
          if (compacted) {
            await this.options.store.saveCompaction(compacted.checkpoint)
            await this.options.broadcast({ type: "chatCompacted", sessionId, compaction: compacted.checkpoint })
          }
        } catch (error) {
          this.options.onError(error)
        }
      }
    } catch (error) {
      this.options.onError(error)
      result = { completed: false, aborted: false, errorMessage: errorMessage(error) }
    }

    try {
      if (result.errorMessage !== null) {
        // The question is left visible as failed rather than silently consumed, so
        // the trader can send it again or drop it.
        await this.options.store.setStatus(asked.id, "FAILED")
        if (automationEvent && this.options.onTurnFailed) {
          try {
            await this.options.onTurnFailed(sessionId, automationEvent)
          } catch (error) {
            this.options.onError(error)
          }
        }
        this.options.broadcast({
          type: "chatRun",
          sessionId,
          runId: run.runId,
          status: "failed",
          promptMessageId: asked.id,
          error: result.errorMessage,
        })
        this.runs.delete(sessionId)
        await this.announceSessions()
        return
      }

      if (result.completed && this.options.onTurnSettled) {
        try {
          await this.options.onTurnSettled(
            sessionId,
            automationEvent,
          )
        } catch (error) {
          this.options.onError(error)
        }
      }
      this.options.broadcast({
        type: "chatRun",
        sessionId,
        runId: run.runId,
        status: result.aborted ? "aborted" : "done",
        promptMessageId: asked.id,
      })
      this.runs.delete(sessionId)
      await this.announceSessions()
    } finally {
      this.runs.delete(sessionId)
    }
  }

  /**
   * Names a conversation beside its main turn, never in front of it.
   *
   * A null result leaves the timestamp in place, so a greeting can be followed by
   * the first meaningful prompt. The store's comparison is the final race guard.
   */
  private maybeStartTitleGeneration(
    sessionId: string,
    expectedTitle: string,
    message: string,
    model: ChatTurnModel,
  ): void {
    if (
      !this.options.generateTitle ||
      !isDefaultChatSessionTitle(expectedTitle) ||
      this.titleRuns.has(sessionId)
    ) return

    const controller = new AbortController()
    this.titleRuns.set(sessionId, controller)
    void this.options.generateTitle({ message, model, signal: controller.signal })
      .then(async (title) => {
        if (!title || controller.signal.aborted || this.removedSessionIds.has(sessionId)) return
        const replaced = await this.options.store.replaceAutomaticTitle(sessionId, expectedTitle, title)
        if (replaced) await this.announceSessions()
      })
      .catch((error) => {
        if (!controller.signal.aborted) this.options.onError(error)
      })
      .finally(() => {
        if (this.titleRuns.get(sessionId) === controller) this.titleRuns.delete(sessionId)
      })
  }

  private async persist(sessionId: string, draft: ChatMessageDraft): Promise<void> {
    if (this.removedSessionIds.has(sessionId)) return
    await this.options.store.append(sessionId, draft)
    await this.options.broadcast({ type: "chatMessage", sessionId, message: draft.message })
  }

  private async sessionTreeIds(sessionId: string): Promise<string[]> {
    const ids = [sessionId]
    let parents = [sessionId]
    while (parents.length > 0) {
      const children = (await Promise.all(parents.map((parent) => this.options.store.listChildren(parent)))).flat()
      parents = children.map((child) => child.id).filter((id) => !ids.includes(id))
      ids.push(...parents)
    }
    return ids
  }

  private partialOf(sessionId: string): ChatPartial | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    const retry = run.retry ? { ...run.retry, reportedAt: this.now() } : null
    return { runId: run.runId, seq: run.seq, text: run.text, reasoning: run.reasoning, retry }
  }

  private withRunState(session: ChatSession): ChatSession {
    return { ...session, running: this.runs.has(session.id) || this.manualCompactions.has(session.id) }
  }

  private async announceSessions(): Promise<void> {
    try {
      this.options.broadcast({ type: "chatSessions", sessions: await this.list() })
    } catch (error) {
      this.options.onError(error)
    }
  }
}

function userRecord(message: ChatMessage): ChatRecord {
  return { role: "user", content: message.text, timestamp: message.createdAt }
}

/** The model a session runs on, or null when it names none. */
function choiceOf(session: ChatSession): ChatModelChoice | null {
  if (!session.provider || !session.model) return null
  return { providerId: session.provider, modelId: session.model, reasoning: session.reasoning }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
