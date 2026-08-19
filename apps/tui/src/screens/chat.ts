import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ChatMessage, ChatSession } from "@trbot/chat/session.ts"
import type { AiAccount } from "@trbot/protocol/ai.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { AiConnectionModal } from "../components/ai-connection-modal.ts"
import { AiModelModal } from "../components/ai-model-modal.ts"
import { ChatSessionModal } from "../components/chat-session-modal.ts"
import { ChatTranscript, type ChatTranscriptBlock } from "../components/chat-transcript.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
import { WORKSPACE_CHROME_BACKGROUND, WORKSPACE_CHROME_MUTED } from "../components/workspace-chrome.ts"
import type { ApplicationLog } from "../logging/application-log.ts"

const BACKGROUND = "#101010"
const PANEL_BG = "#101010"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const REASONING_COLOR = "#6f6f7a"
const QUEUED_COLOR = "#8a8a5a"
const ERROR_COLOR = "#ff6b6b"
const TRADER_COLOR = "#70d7a1"
const MODEL_COLOR = "#7c83ff"
const TOOL_COLOR = "#4a4a52"
const RULE_COLOR = "#2c2c34"

/**
 * One set of keys: control keys, so they work mid-sentence and there is nothing to
 * switch between.
 *
 * The model picker is ^O rather than the ^M its name asks for, because Ctrl+M and
 * Return are the same byte and only a terminal that disambiguates them can tell them
 * apart — where one does not, ^M sends the message instead of opening the picker.
 * ^O is also clear of the field's own editing keys, which take ^A ^E ^F ^B ^W ^K ^U ^D.
 */
const CHAT_HINT = "^O model · ^S chats · ^N new · ^R reasoning · ^P providers"
const CONNECT_HINT = "No model provider connected · ^P to connect one"
const NO_MODEL_HINT = "No model chosen for this chat · ^O to choose one"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL_MS = 120

/** The field is this tall empty, and grows with what is typed up to the second. */
const COMPOSER_MIN_ROWS = 3
const COMPOSER_MAX_ROWS = 8

type Focus = "transcript" | "composer"
type Modal = AiConnectionModal | AiModelModal | ChatSessionModal

export interface ChatScreenOptions {
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
 * The CHAT tab: one conversation, full width, with everything else behind a key.
 *
 * The chats themselves live in a modal rather than a side panel, because a
 * conversation is the thing being read and a list of conversations is wanted for a
 * moment.
 *
 * Every shortcut is a control key, so one spelling serves whether or not something is
 * being typed: a plain letter cannot be a shortcut while a field is taking letters.
 *
 * The server owns every run, so this screen never generates anything: it shows what
 * the server reports and forwards what the trader types. That is why a reply carries
 * on while the trader is watching the market, and why it is complete when they come
 * back.
 */
export class ChatScreen {
  readonly root: BoxRenderable

  private readonly title: TextRenderable
  private readonly meta: TextRenderable
  private readonly transcript: ChatTranscript
  private readonly composerRow: BoxRenderable
  private readonly marker: TextRenderable
  private readonly composer: TextareaRenderable
  private readonly hint: TextRenderable
  private readonly render = new RenderCoalescer(() => this.paint())

  private sessions: ChatSession[] = []
  private messagesBySession = new Map<string, ChatMessage[]>()
  private streamingBySession = new Map<string, Streaming>()
  private selectedSessionId: string | null = null
  private focus: Focus = "composer"
  private connected: boolean | null = null
  private modal: Modal | null = null
  private spinner = 0
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })

    // Title on the left, what will answer on the right: both are things a trader
    // checks before sending, and neither is worth a panel.
    const headerRow = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
      backgroundColor: PANEL_BG,
    })
    this.title = new TextRenderable(renderer, { content: "", flexGrow: 1, wrapMode: "none" })
    this.meta = new TextRenderable(renderer, { content: "", flexShrink: 0, wrapMode: "none" })
    headerRow.add(this.title)
    headerRow.add(this.meta)

    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
    })
    this.transcript = new ChatTranscript(renderer, { backgroundColor: PANEL_BG })
    body.add(this.transcript.root)

    // A rule above the field, so a long reply ending mid-sentence is not mistaken for
    // something typed.
    this.composerRow = new BoxRenderable(renderer, {
      width: "100%",
      height: COMPOSER_MIN_ROWS + 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      border: ["top"],
      borderColor: RULE_COLOR,
      backgroundColor: PANEL_BG,
    })
    this.marker = new TextRenderable(renderer, {
      content: "› ",
      fg: MODEL_COLOR,
      width: 2,
      flexShrink: 0,
      wrapMode: "none",
    })
    // A field rather than a single-line input: a question worth asking a model rarely
    // fits in one line, and one that scrolls sideways cannot be read back before it is
    // sent. Return sends it, so Shift+Return is what makes a new line.
    this.composer = new TextareaRenderable(renderer, {
      flexGrow: 1,
      height: COMPOSER_MIN_ROWS,
      wrapMode: "word",
      placeholder: "ask something…",
      backgroundColor: PANEL_BG,
      focusedBackgroundColor: PANEL_BG,
      textColor: TEXT_COLOR,
    })
    this.composerRow.add(this.marker)
    this.composerRow.add(this.composer)

    const footer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: WORKSPACE_CHROME_BACKGROUND,
    })
    this.hint = new TextRenderable(renderer, {
      content: CHAT_HINT,
      fg: WORKSPACE_CHROME_MUTED,
      width: "100%",
    })
    footer.add(this.hint)

    this.root.add(headerRow)
    this.root.add(body)
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
    return this.typing() || this.modal !== null
  }

  handleKey(key: KeyEvent): void {
    if (this.destroyed) return
    // This screen routes every key itself, including the ones it hands to the composer.
    // The composer is a focused renderable, so the terminal would deliver the same key
    // to the field a second time and every character would land twice — marking it
    // handled here is what keeps the field's own delivery from doubling ours. The same
    // holds while a modal is up: the composer keeps focus behind it, so an API key typed
    // into the modal would otherwise be typed into the chat as well.
    key.preventDefault()
    if (this.modal) {
      this.modal.handleKey(key)
      return
    }
    // Control keys, so every one of them works mid-sentence.
    if (isControl(key, "s")) {
      this.openSessions()
      return
    }
    if (isControl(key, "n")) {
      void this.createSession()
      return
    }
    if (isControl(key, "o")) {
      void this.openModelPicker("model")
      return
    }
    if (isControl(key, "r")) {
      void this.openModelPicker("reasoning")
      return
    }
    if (isControl(key, "p")) {
      this.openConnection()
      return
    }
    if (isControl(key, "x")) {
      void this.cancelQueued()
      return
    }
    // Esc means stop, and only stop: nothing here needs a key for changing focus.
    if (key.name === "escape" || key.name === "esc") {
      void this.stopReply()
      return
    }
    if (key.name === "tab" || key.name === "backtab") {
      this.setFocus(this.typing() ? "transcript" : "composer")
      return
    }
    // Reading back through a conversation without leaving the field first.
    if (key.name === "pageup" || key.name === "pagedown") {
      this.transcript.handleKey(key)
      return
    }
    if (this.typing()) {
      this.handleComposerKey(key)
      return
    }
    if (isEnter(key)) {
      // Whatever the field is waiting on: a provider, a model, or something to type.
      if (this.connected === false) this.openConnection()
      else if (!this.selectedHasModel()) void this.openModelPicker("model")
      else this.setFocus("composer")
      return
    }
    this.transcript.handleKey(key)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.render.cancel()
    this.stopSpinner()
    this.closeModal()
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
      const providers = await this.options.account.providers()
      this.connected = providers.some((provider) => provider.connected)
    } catch (error) {
      this.connected = false
      this.options.logs.error("Model providers", error)
    }
    this.render.schedule()
  }

  private handleComposerKey(key: KeyEvent): void {
    // Return sends, so a new line is Shift+Return — the field is several lines tall and
    // a long question wants paragraphs.
    if (isEnter(key)) {
      if (key.shift) this.composer.insertText("\n")
      else void this.sendComposed()
      this.render.schedule()
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
    const text = this.composer.plainText.trim()
    if (!text) return
    const session = this.selectedSession() ?? await this.startSession()
    if (!session || this.destroyed) return
    try {
      this.composer.setText("")
      this.render.schedule()
      // Shown from what the server answered rather than waiting for the frame that
      // announces it: the message is already stored by the time this returns, and a
      // transcript that lagged behind the field would look like nothing happened.
      this.acceptMessage(session.id, await this.options.chats.send(session.id, text))
    } catch (error) {
      this.options.logs.error("Chat", error)
      // Handing the text back rather than losing it: the trader can send again.
      this.composer.setText(text)
      this.render.schedule()
    }
  }

  private async createSession(): Promise<void> {
    if (this.modal) this.closeModal()
    const session = await this.startSession()
    if (!session) return
    this.setFocus("composer")
    this.render.schedule()
  }

  /** Opens a chat to hold what comes next, and selects it. */
  private async startSession(): Promise<ChatSession | null> {
    try {
      const session = await this.options.chats.create()
      if (this.destroyed) return null
      this.rememberSession(session)
      this.selectedSessionId = session.id
      this.messagesBySession.set(session.id, [])
      this.render.schedule()
      return session
    } catch (error) {
      this.options.logs.error("Chat", error)
      return null
    }
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

  // --- modals -------------------------------------------------------------------

  /** The chats, on ^L: pick one, start one, or delete one. */
  private openSessions(): void {
    if (this.modal || this.destroyed) return
    this.showModal(new ChatSessionModal(this.renderer, {
      sessions: this.sessions,
      currentId: this.selectedSessionId,
      onSelect: (sessionId) => {
        this.selectSession(sessionId)
        this.closeModal()
      },
      onCreate: () => void this.createSession(),
      // The modal stays up after a delete, so several can go in one visit; the list
      // behind it is repainted from what the server confirmed.
      onDelete: (sessionId) => void this.deleteSession(sessionId),
      onClose: () => this.closeModal(),
    }))
  }

  private openConnection(): void {
    const account = this.options.account
    if (!account || this.modal || this.destroyed) return
    this.showModal(new AiConnectionModal(this.renderer, {
      account,
      onChanged: () => this.render.schedule(),
      onClose: () => this.closeModal(),
    }))
  }

  /**
   * Points this chat at a model, or at a different reasoning level.
   *
   * Per chat rather than globally: a trader comparing two models keeps two chats open,
   * and each transcript says which model wrote it. Opening the picker with no chat yet
   * starts one, so choosing a model is never blocked on having something to say.
   */
  private async openModelPicker(initial: "model" | "reasoning"): Promise<void> {
    const account = this.options.account
    if (!account || this.modal || this.destroyed) return
    const session = this.selectedSession() ?? await this.startSession()
    if (!session || this.modal || this.destroyed) return
    const current = session.provider && session.model
      ? { providerId: session.provider, modelId: session.model, reasoning: session.reasoning }
      : null
    this.showModal(new AiModelModal(this.renderer, {
      load: () => account.models(),
      current,
      initial,
      title: "Model for this chat",
      onChoose: async (choice) => {
        const updated = await this.options.chats.configure(session.id, choice)
        this.rememberSession(updated)
        this.render.schedule()
      },
      onClose: () => this.closeModal(),
    }))
  }

  private showModal(modal: Modal): void {
    this.modal = modal
    this.root.add(modal.root)
    if ("mount" in modal) modal.mount()
    this.renderer.requestRender()
  }

  private closeModal(): void {
    const modal = this.modal
    if (!modal) return
    this.modal = null
    if (!this.root.isDestroyed && !modal.root.isDestroyed) this.root.remove(modal.root)
    modal.destroy()
    // A connection may have been made or dropped in there, and whether the composer is
    // offered at all depends on it.
    void this.refreshConnection()
    this.renderer.requestRender()
  }

  // --- state --------------------------------------------------------------------

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

  private selectSession(sessionId: string): void {
    if (sessionId === this.selectedSessionId) return
    this.selectedSessionId = sessionId
    if (!this.messagesBySession.has(sessionId)) void this.loadSession(sessionId)
    this.render.schedule()
  }

  private selectedSession(): ChatSession | null {
    return this.sessions.find((session) => session.id === this.selectedSessionId) ?? null
  }

  /**
   * Whether the selected chat knows which model should answer it.
   *
   * True when no chat is selected yet: the first message creates one, and it is the
   * server that decides what a new chat starts on. Only a chat that exists and names
   * no model is a dead end worth blocking the composer for.
   */
  private selectedHasModel(): boolean {
    const session = this.selectedSession()
    if (!session) return true
    return Boolean(session.provider && session.model)
  }

  private setFocus(focus: Focus): void {
    if (this.focus === focus) return
    this.focus = focus
    if (focus === "composer") this.composer.focus()
    else this.composer.blur()
    this.render.schedule()
  }

  /** Whether the field is taking letters, which decides whether they are shortcuts. */
  private typing(): boolean {
    return this.focus === "composer" && this.composerUsable()
  }

  /** No provider or no model means there is nothing to type into yet. */
  private composerUsable(): boolean {
    return this.connected !== false && this.selectedHasModel()
  }

  // --- painting ----------------------------------------------------------------

  private paint(): void {
    if (this.destroyed) return
    const session = this.selectedSession()
    this.title.content = new StyledText([fg(TEXT_COLOR)(session?.title ?? "Chat")])
    this.meta.content = this.metaText(session)
    this.syncSpinner(session)
    this.transcript.setBlocks(this.transcriptBlocks(session))
    this.composerRow.visible = this.composerUsable()
    // The field grows with what is being written, up to a share of the screen; past
    // that it scrolls, because the conversation still has to be visible above it.
    const rows = Math.min(COMPOSER_MAX_ROWS, Math.max(COMPOSER_MIN_ROWS, this.composer.virtualLineCount))
    this.composer.height = rows
    this.composerRow.height = rows + 1
    this.marker.fg = this.typing() ? MODEL_COLOR : MUTED_COLOR
    this.hint.content = this.hintText()
    // The chats list is live while it is open: a reply landing elsewhere shows there.
    if (this.modal instanceof ChatSessionModal) this.modal.setSessions(this.sessions, this.selectedSessionId)
    this.renderer.requestRender()
  }

  /** What will answer, and whether it is busy — the two things worth the header. */
  private metaText(session: ChatSession | null): StyledText {
    if (!session) return new StyledText([fg(MUTED_COLOR)("")])
    const parts: string[] = []
    if (session.running || this.streamingBySession.has(session.id)) parts.push("answering…")
    if (session.queued > 0) parts.push(`+${session.queued} queued`)
    if (session.model) parts.push(session.reasoning ? `${session.model} · ${session.reasoning}` : session.model)
    else parts.push("no model")
    return new StyledText([fg(MUTED_COLOR)(parts.join("  ·  "))])
  }

  /**
   * Turns the spinner while a reply is coming, and only then.
   *
   * A timer that ran the whole time would repaint a screen nobody is waiting on, and
   * one that never ran would leave a thinking model looking like a hung one.
   */
  private syncSpinner(session: ChatSession | null): void {
    const running = session !== null && this.streamingBySession.has(session.id)
    if (!running) {
      this.stopSpinner()
      return
    }
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      this.spinner = (this.spinner + 1) % SPINNER_FRAMES.length
      this.render.schedule()
    }, SPINNER_INTERVAL_MS)
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
    this.spinner = 0
  }

  /** The same keys whatever is happening; only a missing provider or model displaces them. */
  private hintText(): string {
    if (this.connected === false) return CONNECT_HINT
    if (!this.selectedHasModel()) return NO_MODEL_HINT
    return CHAT_HINT
  }

  private transcriptBlocks(session: ChatSession | null): ChatTranscriptBlock[] {
    if (this.connected === false) {
      return [note("No model provider connected.\n\nPress ^P to connect one — a subscription sign-in or an API key.")]
    }
    if (!session) {
      return [note("No chat yet.\n\nType below to start one, or ^S to open an older chat.")]
    }
    if (!this.selectedHasModel()) {
      return [note("No model chosen for this chat.\n\nPress ^O to choose which model answers it.")]
    }

    const current = modelLabel(session.model || "model", session.reasoning)
    const blocks = (this.messagesBySession.get(session.id) ?? []).map((message) => messageBlock(message, current))
    const streaming = this.streamingBySession.get(session.id)
    if (streaming) blocks.push(streamingBlock(streaming, current, SPINNER_FRAMES[this.spinner] ?? SPINNER_FRAMES[0]!))
    if (blocks.length === 0) return [note("Nothing said yet.")]
    return blocks
  }
}

/** A message, railed by who said it. */
function messageBlock(message: ChatMessage, current: StyledText): ChatTranscriptBlock {
  if (message.role === "USER") {
    const queued = message.status === "QUEUED"
    const chunks: TextChunk[] = [fg(queued ? QUEUED_COLOR : TEXT_COLOR)(message.text)]
    if (queued) chunks.push(fg(QUEUED_COLOR)("\nqueued · ^X cancels it"))
    if (message.status === "FAILED") chunks.push(fg(ERROR_COLOR)("\nfailed"))
    return {
      id: message.id,
      name: "you",
      nameColor: TRADER_COLOR,
      railColor: queued ? QUEUED_COLOR : TRADER_COLOR,
      content: new StyledText(chunks),
    }
  }
  if (message.role === "TOOL_RESULT") {
    return {
      id: message.id,
      name: message.toolName ?? "tool",
      nameColor: MUTED_COLOR,
      railColor: message.isError ? ERROR_COLOR : TOOL_COLOR,
      content: new StyledText([fg(message.isError ? ERROR_COLOR : MUTED_COLOR)(message.text)]),
    }
  }
  const chunks: TextChunk[] = [fg(TEXT_COLOR)(message.text)]
  if (message.status === "PARTIAL") chunks.push(fg(MUTED_COLOR)("\nstopped"))
  if (message.errorMessage) chunks.push(fg(ERROR_COLOR)(`\n${message.errorMessage}`))
  return {
    id: message.id,
    name: message.model ? modelLabel(message.model, message.reasoning) : current,
    railColor: MODEL_COLOR,
    content: new StyledText(chunks),
  }
}

/**
 * The reply being written.
 *
 * A model can think for a long time before its first word, so the spinner turns from
 * the moment the run starts: a still cursor and a stalled run look identical.
 */
function streamingBlock(streaming: Streaming, current: StyledText, spinner: string): ChatTranscriptBlock {
  const chunks: TextChunk[] = []
  if (streaming.text) chunks.push(fg(TEXT_COLOR)(streaming.text), fg(MUTED_COLOR)("▌"))
  else if (streaming.reasoning) chunks.push(fg(REASONING_COLOR)(lastLine(streaming.reasoning)))
  else chunks.push(fg(MUTED_COLOR)("thinking…"))
  for (const tool of streaming.tools) chunks.push(fg(MUTED_COLOR)(`\n· ${tool}`))
  return {
    id: `streaming-${streaming.runId}`,
    name: new StyledText([...current.chunks, fg(MODEL_COLOR)(`  ${spinner}`)]),
    railColor: MODEL_COLOR,
    content: new StyledText(chunks),
  }
}

/**
 * What answered, and how hard it was thinking.
 *
 * Taken from the message where it recorded one, so pointing a chat at another model
 * relabels nothing that came before it.
 */
function modelLabel(model: string, reasoning: string | null): StyledText {
  const chunks: TextChunk[] = [fg(MODEL_COLOR)(model)]
  if (reasoning) chunks.push(fg(MUTED_COLOR)(`  ${reasoning}`))
  return new StyledText(chunks)
}

/** Something the screen is saying itself, so it carries no name and no rail. */
function note(text: string): ChatTranscriptBlock {
  return { id: "note", railColor: PANEL_BG, content: new StyledText([fg(MUTED_COLOR)(text)]) }
}

/** Reasoning is long and only its tail is worth the room while it streams. */
function lastLine(reasoning: string): string {
  const lines = reasoning.split("\n").filter((line) => line.trim().length > 0)
  return lines[lines.length - 1] ?? ""
}

function isControl(key: KeyEvent, letter: string): boolean {
  return Boolean(key.ctrl) && !key.meta && !key.option && key.name === letter
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter"
}
