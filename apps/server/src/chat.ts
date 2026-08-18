import type { ChatRecord, ChatTurnOptions, ChatTurnResult } from "@trbot/ai/chat.ts"
import {
  chatBlockText,
  chatSessionTitle,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatPartial,
  type ChatSession,
  type ChatSessionDetail,
  type ChatSessionStore,
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

export interface ChatControllerOptions {
  store: ChatSessionStore
  agent: ChatTurnRunner
  /** The model this server is configured to use, recorded on each new session. */
  model: string
  /** Refused before a run starts, so "not connected" is an ordinary error. */
  requireConnected: () => Promise<void>
  broadcast: (frame: ChatFrame) => void
  onError: (error: unknown) => void
  now?: () => number
}

/** A reply being generated right now. */
interface ChatRun {
  runId: string
  seq: number
  text: string
  reasoning: string
  controller: AbortController
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
  /** The last known session list, so a socket opening costs no query. */
  private sessions: ChatSession[] = []
  /** Sessions whose queue is being worked through, so a second send does not start a race. */
  private readonly draining = new Set<string>()
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

  async create(): Promise<ChatSession> {
    const now = this.now()
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: chatSessionTitle(""),
      model: this.options.model,
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

  async detail(sessionId: string): Promise<ChatSessionDetail> {
    const detail = await this.options.store.get(sessionId)
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
    this.abortRun(sessionId)
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
      createdAt: this.now(),
    }
    await this.options.store.append(sessionId, { message, record: userRecord(message) })

    // A session is named after what was first asked of it. Renaming on every
    // message would rewrite the list under the trader as they typed.
    if (detail.messages.length === 0) {
      await this.options.store.rename(sessionId, chatSessionTitle(text))
    }

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

  /**
   * Stops the reply being generated now, keeping what it produced.
   *
   * The rest of the queue is left alone: stopping one answer is not the same as
   * clearing what is waiting, and a trader who meant the second has `cancel`.
   */
  async abort(sessionId: string): Promise<void> {
    await this.detail(sessionId)
    this.abortRun(sessionId)
  }

  destroy(): void {
    this.destroyed = true
    for (const run of this.runs.values()) run.controller.abort()
    this.runs.clear()
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
      frames.push({ type: "chatRun", sessionId, runId: run.runId, status: "running" })
    }
    return frames
  }

  private abortRun(sessionId: string): void {
    this.runs.get(sessionId)?.controller.abort()
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

      try {
        await this.options.requireConnected()
      } catch (error) {
        // Not connected is not a failure of the message: it waits where it is and
        // runs when a login arrives, rather than being marked failed and lost.
        this.options.broadcast({
          type: "chatRun",
          sessionId,
          runId: next.id,
          status: "failed",
          error: errorMessage(error),
        })
        return
      }

      await this.runTurn(sessionId, next)
    }
  }

  private async runTurn(sessionId: string, asked: ChatMessage): Promise<void> {
    // Read while the question is still queued, so the history is what came before
    // it and the model is not handed the same question twice.
    const history = (await this.options.store.records(sessionId)) as ChatRecord[]

    const run: ChatRun = {
      runId: crypto.randomUUID(),
      seq: 0,
      text: "",
      reasoning: "",
      controller: new AbortController(),
    }
    this.runs.set(sessionId, run)
    this.options.broadcast({ type: "chatRun", sessionId, runId: run.runId, status: "running" })
    await this.announceSessions()

    // Marked sent before the turn runs: a server that dies mid-turn must not
    // replay the question on restart, which would answer it twice. This also moves
    // it to the end of the conversation, which is where it was actually asked.
    await this.options.store.markSent(asked.id)

    let result: { completed: boolean; aborted: boolean; errorMessage: string | null }
    try {
      result = await this.options.agent.run({
        history,
        prompt: asked.text,
        signal: run.controller.signal,
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
          onToolCall: (name) => {
            run.seq += 1
            this.options.broadcast({
              type: "chatDelta",
              sessionId,
              runId: run.runId,
              seq: run.seq,
              toolName: name,
            })
          },
          onMessage: (draft) => this.persist(sessionId, draft),
        },
      })
    } catch (error) {
      this.options.onError(error)
      result = { completed: false, aborted: false, errorMessage: errorMessage(error) }
    } finally {
      this.runs.delete(sessionId)
    }

    if (result.errorMessage !== null) {
      // The question is left visible as failed rather than silently consumed, so
      // the trader can send it again or drop it.
      await this.options.store.setStatus(asked.id, "FAILED")
      this.options.broadcast({
        type: "chatRun",
        sessionId,
        runId: run.runId,
        status: "failed",
        error: result.errorMessage,
      })
      await this.announceSessions()
      return
    }

    this.options.broadcast({
      type: "chatRun",
      sessionId,
      runId: run.runId,
      status: result.aborted ? "aborted" : "done",
    })
    await this.announceSessions()
  }

  private async persist(sessionId: string, draft: ChatMessageDraft): Promise<void> {
    await this.options.store.append(sessionId, draft)
    this.options.broadcast({ type: "chatMessage", sessionId, message: draft.message })
  }

  private partialOf(sessionId: string): ChatPartial | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    return { runId: run.runId, seq: run.seq, text: run.text, reasoning: run.reasoning }
  }

  private withRunState(session: ChatSession): ChatSession {
    return { ...session, running: this.runs.has(session.id) }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
