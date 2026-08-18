import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ChatMessage, ChatSession } from "@trbot/chat/session.ts"
import type { AiAccount } from "@trbot/protocol/ai.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { AiAccountModal } from "../components/ai-account-modal.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
import { SelectableList } from "../components/selectable-list.ts"
import { WORKSPACE_CHROME_BACKGROUND, WORKSPACE_CHROME_MUTED } from "../components/workspace-chrome.ts"
import type { ApplicationLog } from "../logging/application-log.ts"

const BACKGROUND = "#101010"
const PANEL_BG = "#101010"
const SELECTED_ROW_BG = "#1d1d2b"
const FOCUSED_HEADER = "#7c83ff"
const UNFOCUSED_HEADER = "#666666"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const REASONING_COLOR = "#6f6f7a"
const QUEUED_COLOR = "#8a8a5a"
const ERROR_COLOR = "#ff6b6b"
const CONFIRM_COLOR = "#e5c07b"
const TRADER_COLOR = "#70d7a1"
const MODEL_COLOR = "#7c83ff"
const SESSIONS_WIDTH = 30

const AI_HINT = "Tab focus · n new · d d delete · x cancel · Esc stop · c connection"
const CONNECT_HINT = "ChatGPT is not connected · Enter to connect"

type Focus = "sessions" | "transcript" | "composer"

export interface AiScreenOptions {
  chats: ChatSessions
  account?: AiAccount
  logs: ApplicationLog
}

/** A reply arriving now, before it has been stored as a message. */
interface Streaming {
  runId: string
  text: string
  reasoning: string
  tools: string[]
}

/**
 * The AI tab: the ChatGPT connection and a conversation per session.
 *
 * The server owns every run, so this screen never generates anything — it shows
 * what the server reports and forwards what the trader types. That is why a reply
 * carries on while the trader is watching the market, and why it is complete when
 * they come back.
 */
export class AiScreen {
  readonly root: BoxRenderable

  private readonly sessionList: SelectableList
  private readonly sessionsHeader: TextRenderable
  private readonly transcript: ScrollBoxRenderable
  private readonly transcriptBody: TextRenderable
  private readonly transcriptHeader: TextRenderable
  private readonly composerRow: BoxRenderable
  private readonly composer: InputRenderable
  private readonly hint: TextRenderable
  private readonly render = new RenderCoalescer(() => this.paint())

  private sessions: ChatSession[] = []
  private messagesBySession = new Map<string, ChatMessage[]>()
  private streamingBySession = new Map<string, Streaming>()
  private selectedSessionId: string | null = null
  private focus: Focus = "composer"
  private connected: boolean | null = null
  private modal: AiAccountModal | null = null
  private pendingDelete: string | null = null
  private deleteTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AiScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })

    const columns = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
    })

    const sessionsPanel = new BoxRenderable(renderer, {
      width: SESSIONS_WIDTH,
      flexShrink: 0,
      height: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
    })
    this.sessionsHeader = new TextRenderable(renderer, { content: "SESSIONS", marginBottom: 1 })
    this.sessionList = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_ROW_BG,
      wrapContent: true,
      onSelect: (index) => this.selectSessionAt(index),
      onFocusRequest: () => this.setFocus("sessions"),
    })
    sessionsPanel.add(this.sessionsHeader)
    sessionsPanel.add(this.sessionList.root)

    const transcriptPanel = new BoxRenderable(renderer, {
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
    })
    this.transcriptHeader = new TextRenderable(renderer, { content: "", marginBottom: 1 })
    this.transcript = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      backgroundColor: PANEL_BG,
      contentOptions: { flexDirection: "column", paddingRight: 1, backgroundColor: PANEL_BG },
    })
    this.transcriptBody = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.transcript.add(this.transcriptBody)
    transcriptPanel.add(this.transcriptHeader)
    transcriptPanel.add(this.transcript)

    columns.add(sessionsPanel)
    columns.add(transcriptPanel)

    this.composerRow = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
    })
    this.composer = new InputRenderable(renderer, {
      width: "100%",
      placeholder: "ask something…",
      backgroundColor: PANEL_BG,
      focusedBackgroundColor: PANEL_BG,
      textColor: TEXT_COLOR,
    })
    this.composerRow.add(this.composer)

    const footer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: WORKSPACE_CHROME_BACKGROUND,
    })
    this.hint = new TextRenderable(renderer, {
      content: AI_HINT,
      fg: WORKSPACE_CHROME_MUTED,
      width: "100%",
    })
    footer.add(this.hint)

    this.root.add(columns)
    this.root.add(this.composerRow)
    this.root.add(footer)
    this.paint()
  }

  mount(): void {
    void this.load()
  }

  /**
   * The composer takes letters, so while it holds focus the tab shortcuts must
   * not: typing "Tomorrow" would otherwise leave the tab.
   */
  capturesInput(): boolean {
    return this.focus === "composer" || this.modal !== null
  }

  handleKey(key: KeyEvent): void {
    if (this.destroyed) return
    if (this.modal) {
      this.modal.handleKey(key)
      return
    }
    if (this.focus === "composer") {
      this.handleComposerKey(key)
      return
    }
    if (key.name === "tab" || key.name === "backtab") {
      this.moveFocus(key.shift || key.name === "backtab" ? -1 : 1)
      return
    }
    if (isLowercase(key, "c")) {
      this.openConnection()
      return
    }
    if (isLowercase(key, "n")) {
      void this.createSession()
      return
    }
    if (isLowercase(key, "d")) {
      this.confirmDelete()
      return
    }
    if (isLowercase(key, "x")) {
      void this.cancelQueued()
      return
    }
    if (key.name === "escape" || key.name === "esc") {
      void this.stopReply()
      return
    }
    if (this.focus === "sessions") {
      this.sessionList.handleKey(key)
      return
    }
    this.transcript.handleKeyPress(key)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.render.cancel()
    if (this.deleteTimer) clearTimeout(this.deleteTimer)
    this.closeConnection()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  // --- what the server reports -------------------------------------------------

  acceptSessions(sessions: ChatSession[]): void {
    if (this.destroyed) return
    this.sessions = sessions
    if (!this.selectedSessionId || !sessions.some((session) => session.id === this.selectedSessionId)) {
      this.selectedSessionId = sessions[0]?.id ?? null
      if (this.selectedSessionId) void this.loadSession(this.selectedSessionId)
    }
    this.render.schedule()
  }

  acceptMessage(sessionId: string, message: ChatMessage): void {
    if (this.destroyed) return
    const messages = this.messagesBySession.get(sessionId) ?? []
    const existing = messages.findIndex((entry) => entry.id === message.id)
    if (existing >= 0) messages[existing] = message
    else messages.push(message)
    this.messagesBySession.set(sessionId, messages)
    // A stored reply replaces what was streaming, so the words are not shown twice.
    if (message.role === "ASSISTANT") this.streamingBySession.delete(sessionId)
    this.render.schedule()
  }

  acceptMessageRemoved(sessionId: string, messageId: string): void {
    if (this.destroyed) return
    const messages = this.messagesBySession.get(sessionId)
    if (!messages) return
    this.messagesBySession.set(sessionId, messages.filter((message) => message.id !== messageId))
    this.render.schedule()
  }

  acceptDelta(sessionId: string, runId: string, delta: { text?: string; reasoning?: string; toolName?: string }): void {
    if (this.destroyed) return
    const current = this.streamingBySession.get(sessionId)
    const streaming: Streaming = current?.runId === runId
      ? current
      : { runId, text: "", reasoning: "", tools: [] }
    if (delta.text) streaming.text += delta.text
    if (delta.reasoning) streaming.reasoning += delta.reasoning
    if (delta.toolName) streaming.tools.push(delta.toolName)
    this.streamingBySession.set(sessionId, streaming)
    this.render.schedule()
  }

  acceptRun(sessionId: string, _runId: string, status: string, error?: string): void {
    if (this.destroyed) return
    if (status !== "running") this.streamingBySession.delete(sessionId)
    if (error) this.options.logs.error("Chat", new Error(error))
    this.render.schedule()
  }

  /** Re-reads a session after a missed frame, so no transcript keeps a hole. */
  resync(sessionId: string): void {
    if (this.destroyed) return
    void this.loadSession(sessionId)
  }

  // --- what the trader asks for ------------------------------------------------

  private async load(): Promise<void> {
    await this.refreshConnection()
    try {
      this.sessions = await this.options.chats.list()
      this.selectedSessionId = this.sessions[0]?.id ?? null
      if (this.selectedSessionId) await this.loadSession(this.selectedSessionId)
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
    this.render.schedule()
  }

  private async loadSession(sessionId: string): Promise<void> {
    try {
      const detail = await this.options.chats.get(sessionId)
      if (this.destroyed) return
      this.messagesBySession.set(sessionId, detail.messages)
      if (detail.partial) {
        this.streamingBySession.set(sessionId, {
          runId: detail.partial.runId,
          text: detail.partial.text,
          reasoning: detail.partial.reasoning,
          tools: [],
        })
      } else {
        this.streamingBySession.delete(sessionId)
      }
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  private async refreshConnection(): Promise<void> {
    if (!this.options.account) {
      this.connected = false
      return
    }
    try {
      this.connected = (await this.options.account.getState()) !== null
    } catch (error) {
      this.connected = false
      this.options.logs.error("ChatGPT", error)
    }
    this.render.schedule()
  }

  private handleComposerKey(key: KeyEvent): void {
    if (key.name === "tab" || key.name === "backtab") {
      this.moveFocus(key.shift || key.name === "backtab" ? -1 : 1)
      return
    }
    if (key.name === "escape" || key.name === "esc") {
      // Stops the reply if one is running, and otherwise steps out of the field —
      // one key, in the order a trader means it.
      if (this.streamingBySession.has(this.selectedSessionId ?? "")) void this.stopReply()
      else this.setFocus("sessions")
      return
    }
    if (this.connected === false) {
      if (key.name === "return" || key.name === "enter") this.openConnection()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      void this.sendComposed()
      return
    }
    this.composer.handleKeyPress(key)
    this.render.schedule()
  }

  /**
   * Sends what is typed, or queues it if a reply is already running.
   *
   * The field is cleared immediately because the server has taken the message: a
   * trader whose text stayed put would not know whether it went.
   */
  private async sendComposed(): Promise<void> {
    const text = this.composer.value.trim()
    if (!text) return
    let sessionId = this.selectedSessionId
    try {
      if (!sessionId) {
        const session = await this.options.chats.create()
        this.rememberSession(session)
        sessionId = session.id
        this.selectedSessionId = sessionId
      }
      this.composer.value = ""
      this.render.schedule()
      // Shown from what the server answered rather than waiting for the frame that
      // announces it: the message is already stored by the time this returns, and a
      // transcript that lagged behind the field would look like nothing happened.
      this.acceptMessage(sessionId, await this.options.chats.send(sessionId, text))
    } catch (error) {
      this.options.logs.error("Chat", error)
      // Handing the text back rather than losing it: the trader can send again.
      this.composer.value = text
      this.render.schedule()
    }
  }

  private async createSession(): Promise<void> {
    try {
      const session = await this.options.chats.create()
      this.rememberSession(session)
      this.selectedSessionId = session.id
      this.messagesBySession.set(session.id, [])
      this.setFocus("composer")
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  /**
   * Deleting takes two presses of `d`, matching the trade screen.
   *
   * A conversation is not recoverable, and `d` is one key away from the keys that
   * move the selection.
   */
  private confirmDelete(): void {
    const sessionId = this.selectedSessionId
    if (!sessionId) return
    if (this.pendingDelete === sessionId) {
      this.clearPendingDelete()
      void this.deleteSession(sessionId)
      return
    }
    this.pendingDelete = sessionId
    if (this.deleteTimer) clearTimeout(this.deleteTimer)
    this.deleteTimer = setTimeout(() => this.clearPendingDelete(), 3_000)
    this.render.schedule()
  }

  private clearPendingDelete(): void {
    if (this.deleteTimer) clearTimeout(this.deleteTimer)
    this.deleteTimer = null
    if (this.pendingDelete === null) return
    this.pendingDelete = null
    this.render.schedule()
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.options.chats.delete(sessionId)
      this.messagesBySession.delete(sessionId)
      this.streamingBySession.delete(sessionId)
      this.sessions = this.sessions.filter((session) => session.id !== sessionId)
      if (this.selectedSessionId === sessionId) {
        this.selectedSessionId = this.sessions[0]?.id ?? null
        if (this.selectedSessionId) await this.loadSession(this.selectedSessionId)
      }
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  /** Takes back the last message still waiting its turn. */
  private async cancelQueued(): Promise<void> {
    const sessionId = this.selectedSessionId
    if (!sessionId) return
    const queued = (this.messagesBySession.get(sessionId) ?? []).filter((message) => message.status === "QUEUED")
    const last = queued[queued.length - 1]
    if (!last) return
    try {
      await this.options.chats.cancel(sessionId, last.id)
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  private async stopReply(): Promise<void> {
    const sessionId = this.selectedSessionId
    if (!sessionId || !this.streamingBySession.has(sessionId)) return
    try {
      await this.options.chats.abort(sessionId)
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  private openConnection(): void {
    const account = this.options.account
    if (!account || this.modal || this.destroyed) return
    const modal = new AiAccountModal(this.renderer, {
      account,
      onClose: () => this.closeConnection(),
    })
    this.modal = modal
    this.root.add(modal.root)
    modal.mount()
    this.renderer.requestRender()
  }

  private closeConnection(): void {
    const modal = this.modal
    if (!modal) return
    this.modal = null
    if (!this.root.isDestroyed && !modal.root.isDestroyed) this.root.remove(modal.root)
    modal.destroy()
    // The connection may have been made or dropped in the modal, and the composer
    // depends on which.
    void this.refreshConnection()
    this.renderer.requestRender()
  }

  /**
   * Holds a session the server just created, without duplicating one already known.
   *
   * The list also arrives by broadcast, so both paths have to be able to run in
   * either order.
   */
  private rememberSession(session: ChatSession): void {
    const known = this.sessions.findIndex((entry) => entry.id === session.id)
    this.sessions = known >= 0
      ? this.sessions.map((entry) => (entry.id === session.id ? session : entry))
      : [...this.sessions, session]
  }

  private selectSessionAt(index: number): void {
    const session = this.sessions[index]
    if (!session || session.id === this.selectedSessionId) return
    this.clearPendingDelete()
    this.selectedSessionId = session.id
    if (!this.messagesBySession.has(session.id)) void this.loadSession(session.id)
    this.render.schedule()
  }

  private moveFocus(direction: number): void {
    const order: Focus[] = ["sessions", "transcript", "composer"]
    const next = order[(order.indexOf(this.focus) + direction + order.length) % order.length]
    if (next) this.setFocus(next)
  }

  private setFocus(focus: Focus): void {
    if (this.focus === focus) return
    this.focus = focus
    if (focus === "composer") this.composer.focus()
    else this.composer.blur()
    this.render.schedule()
  }

  // --- painting ----------------------------------------------------------------

  private paint(): void {
    if (this.destroyed) return
    this.sessionsHeader.content = header("SESSIONS", this.focus === "sessions")
    this.transcriptHeader.content = this.transcriptTitle()
    this.sessionList.setRows(
      this.sessions.map((session) => ({
        id: session.id,
        content: this.sessionRow(session),
      })),
      this.selectedSessionId ?? undefined,
    )
    this.transcriptBody.content = this.transcriptContent()
    this.composerRow.visible = this.connected !== false
    this.hint.content = this.hintText()
    this.hint.fg = this.pendingDelete ? CONFIRM_COLOR : WORKSPACE_CHROME_MUTED
    this.renderer.requestRender()
  }

  private hintText(): string {
    if (this.pendingDelete) {
      const session = this.sessions.find((entry) => entry.id === this.pendingDelete)
      return `Press d again to delete "${session?.title ?? "this chat"}".`
    }
    return this.connected === false ? CONNECT_HINT : AI_HINT
  }

  private sessionRow(session: ChatSession): StyledText {
    const chunks: TextChunk[] = [fg(session.id === this.selectedSessionId ? TEXT_COLOR : MUTED_COLOR)(session.title)]
    const marks: string[] = []
    if (session.running) marks.push("…")
    if (session.queued > 0) marks.push(`+${session.queued}`)
    if (marks.length > 0) chunks.push(fg(MODEL_COLOR)(`  ${marks.join(" ")}`))
    return new StyledText(chunks)
  }

  private transcriptTitle(): StyledText {
    const session = this.sessions.find((entry) => entry.id === this.selectedSessionId)
    const chunks: TextChunk[] = [
      bold(fg(this.focus === "transcript" ? FOCUSED_HEADER : UNFOCUSED_HEADER)("TRANSCRIPT")),
    ]
    if (session) chunks.push(fg(MUTED_COLOR)(`  ·  ${session.model}`))
    return new StyledText(chunks)
  }

  private transcriptContent(): StyledText {
    if (this.connected === false) {
      return new StyledText([
        fg(MUTED_COLOR)("ChatGPT is not connected.\n\n"),
        fg(TEXT_COLOR)("Press Enter to connect in your browser."),
      ])
    }
    const sessionId = this.selectedSessionId
    if (!sessionId) {
      return new StyledText([fg(MUTED_COLOR)("No chats yet. Type below, or press n for a new one.")])
    }

    const chunks: TextChunk[] = []
    for (const message of this.messagesBySession.get(sessionId) ?? []) {
      if (chunks.length > 0) chunks.push(fg(TEXT_COLOR)("\n\n"))
      chunks.push(...messageChunks(message))
    }

    const streaming = this.streamingBySession.get(sessionId)
    if (streaming) {
      if (chunks.length > 0) chunks.push(fg(TEXT_COLOR)("\n\n"))
      chunks.push(fg(MODEL_COLOR)("gpt   "))
      if (streaming.reasoning && !streaming.text) {
        chunks.push(fg(REASONING_COLOR)(lastLine(streaming.reasoning)))
      } else {
        chunks.push(fg(TEXT_COLOR)(streaming.text))
        chunks.push(fg(MUTED_COLOR)("▌"))
      }
      for (const tool of streaming.tools) chunks.push(fg(MUTED_COLOR)(`\n      · ${tool}`))
    }

    if (chunks.length === 0) chunks.push(fg(MUTED_COLOR)("Nothing said yet."))
    return new StyledText(chunks)
  }
}

function messageChunks(message: ChatMessage): TextChunk[] {
  if (message.role === "USER") {
    const queued = message.status === "QUEUED"
    return [
      fg(queued ? QUEUED_COLOR : TRADER_COLOR)("you   "),
      fg(queued ? QUEUED_COLOR : TEXT_COLOR)(message.text),
      ...(queued ? [fg(QUEUED_COLOR)("  (queued · x to take back)")] : []),
      ...(message.status === "FAILED" ? [fg(ERROR_COLOR)("  (failed)")] : []),
    ]
  }
  if (message.role === "TOOL_RESULT") {
    return [
      fg(MUTED_COLOR)(`${(message.toolName ?? "tool").padEnd(6)}`),
      fg(message.isError ? ERROR_COLOR : MUTED_COLOR)(message.text),
    ]
  }
  const chunks: TextChunk[] = [fg(MODEL_COLOR)("gpt   "), fg(TEXT_COLOR)(message.text)]
  if (message.status === "PARTIAL") chunks.push(fg(MUTED_COLOR)("  (stopped)"))
  if (message.errorMessage) chunks.push(fg(ERROR_COLOR)(`\n      ${message.errorMessage}`))
  return chunks
}

function header(title: string, focused: boolean): StyledText {
  return new StyledText([bold(fg(focused ? FOCUSED_HEADER : UNFOCUSED_HEADER)(title))])
}

/** Reasoning is long and only its tail is worth the room while it streams. */
function lastLine(reasoning: string): string {
  const lines = reasoning.split("\n").filter((line) => line.trim().length > 0)
  return lines[lines.length - 1] ?? ""
}

function isLowercase(key: KeyEvent, letter: string): boolean {
  if (key.ctrl || key.shift || key.meta || key.option) return false
  return key.name === letter && key.sequence !== letter.toUpperCase()
}
