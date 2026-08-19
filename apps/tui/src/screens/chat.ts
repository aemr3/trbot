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
import { ChatCommandMenu, type ChatCommand } from "../components/chat-command-menu.ts"
import { ChatHelpModal } from "../components/chat-help-modal.ts"
import { ChatSessionModal } from "../components/chat-session-modal.ts"
import { ChatTranscript, type ChatTranscriptBlock } from "../components/chat-transcript.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
import { SubagentSessionModal } from "../components/subagent-session-modal.ts"
import type { ApplicationLog } from "../logging/application-log.ts"

const BACKGROUND = "#101010"
const PANEL_BG = "#101010"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const FAINT_COLOR = "#5a5a62"
const REASONING_COLOR = "#6f6f7a"
const THOUGHT_COLOR = "#c08a52"
const QUEUED_COLOR = "#8a8a5a"
const ERROR_COLOR = "#ff6b6b"
const MODEL_COLOR = "#d7c58a"
const TOOL_COLOR = "#4a4a52"
const PROMPT_BG = "#292725"
const TURN_MARKER_COLOR = "#8b8580"
/**
 * The field at the foot of the screen. It shares the prompt fill so the empty field reads
 * as the next prompt, with the warm marker identifying the insertion point.
 */
const COMPOSER_BG = PROMPT_BG
const COMPOSER_COLOR = "#d0894a"

/**
 * One set of keys: control keys, so they work mid-sentence and there is nothing to
 * switch between. They are listed in the help modal rather than along the bottom, and
 * `^G` is the only one the screen names for itself.
 *
 * The model picker is ^O rather than the ^M its name asks for, because Ctrl+M and
 * Return are the same byte and only a terminal that disambiguates them can tell them
 * apart — where one does not, ^M sends the message instead of opening the picker.
 * ^O is also clear of the field's own editing keys, which take ^A ^E ^F ^B ^W ^K ^U ^D.
 */
const CHAT_HINT = "^G keys"
const RUNNING_HINT = "Esc interrupt · ^G keys"
const CONNECT_HINT = "No model provider connected · ^P to connect one"
const NO_MODEL_HINT = "No model chosen for this chat · ^O to choose one"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL_MS = 120

/** One quiet terminal cell around the conversation, matching the Codex transcript. */
const CHAT_INSET = 1

/**
 * How far the field grows before it starts scrolling instead.
 *
 * It measures its own content, so it is one line at rest — an empty field three lines
 * tall spends a fifth of a short terminal on nothing, and room for a long question comes
 * from growing into it. Past this the conversation above needs the rest of the screen.
 */
const COMPOSER_MAX_ROWS = 8

const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "/model", description: "choose which model answers this chat" },
  { name: "/reasoning", description: "choose the model's reasoning effort" },
  { name: "/thoughts", description: "show or hide model reasoning" },
  { name: "/subagents", description: "open this chat's worker sessions" },
  { name: "/parent", description: "return from a worker transcript" },
  { name: "/chats", description: "open another chat" },
  { name: "/new", description: "start a new chat" },
  { name: "/connect", description: "manage model providers" },
  { name: "/help", description: "show every chat key" },
]

type Focus = "transcript" | "composer"
type Modal = AiConnectionModal | AiModelModal | ChatSessionModal | ChatHelpModal | SubagentSessionModal

export interface ChatScreenOptions {
  chats: ChatSessions
  account?: AiAccount
  logs: ApplicationLog
  initialSessionId?: string | null
  initialShowThoughts?: boolean
  onSessionChange?: (sessionId: string | null) => void
  onShowThoughtsChange?: (showThoughts: boolean) => void
}

/** A reply arriving now, before it has been stored as a message. */
interface Streaming {
  runId: string
  /**
   * When this terminal saw the run start, for the timer beside the spinner.
   *
   * Null for a run that was already going when the screen attached to it: how long
   * this terminal has been watching is not how long the model has been thinking, and
   * a number that means the wrong thing is worse than no number.
   */
  startedAt: number | null
  /**
   * How long the model thought before its first word, frozen when that word arrived.
   *
   * Measured here as well as on the server so the number does not jump when the stored
   * message replaces the stream: both count from the same event.
   */
  thinkingMs: number | null
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
 * Every shortcut uses a modifier, so one spelling serves whether or not something is
 * being typed: a plain key cannot be a shortcut while a field is taking letters.
 *
 * The server owns every run, so this screen never generates anything: it shows what
 * the server reports and forwards what the trader types. That is why a reply carries
 * on while the trader is watching the market, and why it is complete when they come
 * back.
 */
export class ChatScreen {
  readonly root: BoxRenderable

  private readonly transcript: ChatTranscript
  private readonly commandMenu: ChatCommandMenu
  private readonly composerRow: BoxRenderable
  private readonly composerMarker: TextRenderable
  private readonly composer: TextareaRenderable
  private readonly composerMeta: TextRenderable
  private readonly hint: TextRenderable
  private readonly usage: TextRenderable
  private readonly render = new RenderCoalescer(() => this.paint())

  private sessions: ChatSession[] = []
  private messagesBySession = new Map<string, ChatMessage[]>()
  private streamingBySession = new Map<string, Streaming>()
  /** Context window per `provider/model`, for reading a conversation's usage as a share of it. */
  private contextWindows = new Map<string, number>()
  private selectedSessionId: string | null = null
  private focus: Focus = "composer"
  private connected: boolean | null = null
  private modal: Modal | null = null
  /** Whether replies show the reasoning that led to them, or only that there was some. */
  private showThoughts: boolean
  private spinner = 0
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatScreenOptions,
  ) {
    this.selectedSessionId = options.initialSessionId ?? null
    this.showThoughts = options.initialShowThoughts ?? true
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })

    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      paddingTop: CHAT_INSET,
      paddingLeft: CHAT_INSET,
      paddingRight: CHAT_INSET,
      backgroundColor: PANEL_BG,
    })
    this.transcript = new ChatTranscript(renderer, { backgroundColor: PANEL_BG })
    body.add(this.transcript.root)
    this.commandMenu = new ChatCommandMenu(renderer, CHAT_COMMANDS)

    // The next prompt uses the same filled shape as prompts already in the transcript.
    this.composerRow = new BoxRenderable(renderer, {
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 0,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
      marginTop: 1,
      marginLeft: CHAT_INSET,
      marginRight: CHAT_INSET,
      backgroundColor: COMPOSER_BG,
    })
    this.composerMarker = new TextRenderable(renderer, {
      content: "›",
      width: 2,
      flexShrink: 0,
      fg: COMPOSER_COLOR,
      wrapMode: "none",
    })
    // A field rather than a single-line input: a question worth asking a model rarely
    // fits in one line, and one that scrolls sideways cannot be read back before it is
    // sent. Return sends it, so Shift+Return is what makes a new line.
    //
    // No height, so the layout measures the text and the field is exactly as tall as
    // what is in it, wrapping included. Setting the height by hand cannot do that: the
    // field reports the lines it can currently show, so a one-line field measures one
    // line however much is typed into it, and a paragraph would never open the field it
    // needs.
    this.composer = new TextareaRenderable(renderer, {
      flexGrow: 1,
      maxHeight: COMPOSER_MAX_ROWS,
      wrapMode: "word",
      placeholder: "ask something…",
      backgroundColor: COMPOSER_BG,
      focusedBackgroundColor: COMPOSER_BG,
      textColor: TEXT_COLOR,
    })
    this.composerRow.add(this.composerMarker)
    this.composerRow.add(this.composer)

    // Model, keys and usage form one quiet status line below the field, as in Codex.
    const composerDetails = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      // The model starts under the prompt text, after its inset and marker.
      paddingLeft: CHAT_INSET + 2,
      paddingRight: CHAT_INSET,
      backgroundColor: PANEL_BG,
    })
    this.composerMeta = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      wrapMode: "none",
    })
    this.hint = new TextRenderable(renderer, {
      content: CHAT_HINT,
      fg: MUTED_COLOR,
      flexShrink: 0,
      marginRight: 2,
      wrapMode: "none",
    })
    this.usage = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      flexShrink: 0,
      wrapMode: "none",
    })
    composerDetails.add(this.composerMeta)
    composerDetails.add(this.hint)
    composerDetails.add(this.usage)

    this.root.add(body)
    this.root.add(this.composerRow)
    // As in Codex, slash commands unfold below the prompt instead of covering the
    // conversation or floating over the field being edited.
    this.root.add(this.commandMenu.root)
    this.root.add(composerDetails)
    this.paint()
  }

  mount(): void {
    void this.load()
  }

  /** Restores the place the trader left focused when CHAT becomes visible again. */
  activate(): void {
    if (this.typing()) this.composer.focus()
  }

  /** A hidden textarea must neither draw a cursor nor receive another panel's keys. */
  deactivate(): void {
    this.composer.blur()
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
    if (this.typing() && this.handleCommandMenuKey(key)) return
    if (isAltArrow(key, "right")) {
      void this.cycleSubagent(1)
      return
    }
    if (isAltArrow(key, "left")) {
      void this.cycleSubagent(-1)
      return
    }
    if (isAltArrow(key, "up")) {
      const parentId = this.selectedSession()?.parentSessionId
      if (parentId) this.selectSession(parentId)
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
    // One control folds or opens reasoning across the conversation. Thoughts start
    // open, matching the live Codex transcript; ^T is there when they get in the way.
    if (isControl(key, "t")) {
      this.toggleThoughts()
      return
    }
    if (isControl(key, "g")) {
      this.openHelp()
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
    const knownChildren = this.sessions.filter((session) => session.parentSessionId !== null)
    this.sessions = [
      ...sessions,
      ...knownChildren.filter((child) => !sessions.some((session) => session.id === child.id)),
    ]
    if (!this.selectedSessionId || !this.sessions.some((session) => session.id === this.selectedSessionId)) {
      this.setSelectedSession(this.initialSession(sessions))
      if (this.selectedSessionId) {
        void this.loadSession(this.selectedSessionId)
      }
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
      : { runId, startedAt: Date.now(), thinkingMs: null, text: "", reasoning: "", tools: [] }
    if (delta.text) {
      // The first word is where thinking ended, so that is where the count stops.
      if (streaming.reasoning && !streaming.text && streaming.startedAt !== null) {
        streaming.thinkingMs = Date.now() - streaming.startedAt
      }
      streaming.text += delta.text
    }
    if (delta.reasoning) streaming.reasoning += delta.reasoning
    if (delta.toolName) streaming.tools.push(delta.toolName)
    this.streamingBySession.set(sessionId, streaming)
    this.render.schedule()
  }

  acceptRun(sessionId: string, runId: string, status: string, error?: string): void {
    if (this.destroyed) return
    if (status !== "running") this.streamingBySession.delete(sessionId)
    // A run announces itself before its first delta, and a model can think for a long
    // while before that one arrives: holding the run from here is what makes the
    // spinner turn from the moment the question went rather than from the answer.
    else if (this.streamingBySession.get(sessionId)?.runId !== runId) {
      this.streamingBySession.set(sessionId, { runId, startedAt: Date.now(), thinkingMs: null, text: "", reasoning: "", tools: [] })
    }
    if (error) this.options.logs.error("Chat", new Error(error))
    this.sessions = this.sessions.map((session) => (
      session.id === sessionId ? { ...session, running: status === "running" } : session
    ))
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
      const sessions = await this.options.chats.list()
      if (this.destroyed) return
      this.sessions = sessions
      const preferred = this.options.initialSessionId
      if (preferred && !sessions.some((session) => session.id === preferred)) {
        try {
          this.rememberSession((await this.options.chats.get(preferred)).session)
        } catch {
          // The saved child may have been deleted with its parent; the root fallback below is valid.
        }
      }
      this.setSelectedSession(this.initialSession(this.sessions))
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
      this.rememberSession(detail.session)
      this.messagesBySession.set(sessionId, detail.messages)
      if (detail.partial) {
        const known = this.streamingBySession.get(sessionId)
        // A partial that already carries words is a run this terminal did not watch
        // start, so it keeps no start time: see `Streaming.startedAt`.
        const joined = detail.partial.text.length > 0 || detail.partial.reasoning.length > 0
        this.streamingBySession.set(sessionId, {
          runId: detail.partial.runId,
          startedAt: joined ? null : (known?.runId === detail.partial.runId ? known.startedAt : Date.now()),
          thinkingMs: known?.runId === detail.partial.runId ? known.thinkingMs : null,
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
      if (this.connected) await this.loadContextWindows()
    } catch (error) {
      this.connected = false
      this.options.logs.error("Model providers", error)
    }
    this.render.schedule()
  }

  /**
   * How much room each model has, so the status line can read a conversation's tokens
   * as a share of the window rather than as a number nobody can place.
   *
   * A failure here costs the percentage and nothing else, so it is logged and dropped:
   * the conversation does not depend on it.
   */
  private async loadContextWindows(): Promise<void> {
    const account = this.options.account
    if (!account) return
    try {
      const models = await account.models()
      if (this.destroyed) return
      this.contextWindows = new Map(
        models.map((model) => [`${model.providerId}/${model.modelId}`, model.contextWindow]),
      )
    } catch (error) {
      this.options.logs.error("Model list", error)
    }
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
    this.commandMenu.setQuery(this.composer.plainText)
    this.render.schedule()
  }

  /** Routes command discovery keys while the textarea keeps terminal focus. */
  private handleCommandMenuKey(key: KeyEvent): boolean {
    if (!this.commandMenu.visible) return false
    if (key.name === "escape" || key.name === "esc") {
      this.commandMenu.close()
      this.render.schedule()
      return true
    }
    if (this.commandMenu.handleKey(key)) return true
    if (key.name === "tab") {
      const command = this.commandMenu.selectedCommand()
      if (!command) return false
      this.composer.setText(command.name)
      this.commandMenu.setQuery(command.name)
      this.render.schedule()
      return true
    }
    if (isEnter(key) && !key.shift) {
      const command = this.commandMenu.selectedCommand()
      if (!command) return false
      this.composer.setText(command.name)
      void this.sendComposed()
      return true
    }
    return false
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
    if (await this.runCommand(text)) return
    if (this.selectedSession()?.parentSessionId) return
    const session = this.selectedSession() ?? await this.startSession()
    if (!session || this.destroyed) return
    try {
      this.composer.setText("")
      this.commandMenu.close()
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

  /** Local navigation commands never become trader messages or consume model tokens. */
  private async runCommand(text: string): Promise<boolean> {
    const command = text.toLowerCase()
    if (!CHAT_COMMANDS.some((entry) => entry.name === command)) return false

    this.composer.setText("")
    this.commandMenu.close()
    this.render.schedule()

    switch (command) {
      case "/model":
        await this.openModelPicker("model")
        break
      case "/reasoning":
        await this.openModelPicker("reasoning")
        break
      case "/thoughts":
        this.toggleThoughts()
        break
      case "/subagents":
        await this.openSubagents()
        break
      case "/parent": {
        const parentId = this.selectedSession()?.parentSessionId
        if (parentId) this.selectSession(parentId)
        break
      }
      case "/chats":
        this.openSessions()
        break
      case "/new":
        await this.createSession()
        break
      case "/connect":
        this.openConnection()
        break
      case "/help":
        this.openHelp()
        break
    }
    this.render.schedule()
    return true
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
      this.setSelectedSession(session.id)
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
        this.setSelectedSession(this.sessions[0]?.id ?? null)
        if (this.selectedSessionId) {
          await this.loadSession(this.selectedSessionId)
        }
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
      sessions: this.sessions.filter((session) => session.parentSessionId === null),
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

  private async openSubagents(): Promise<void> {
    if (this.modal || this.destroyed) return
    const selected = this.selectedSession()
    const parentId = selected?.id ?? null
    let sessions: ChatSession[] = []
    if (parentId) {
      try {
        sessions = await this.options.chats.children(parentId)
        if (this.destroyed || this.modal) return
        for (const session of sessions) this.rememberSession(session)
      } catch (error) {
        this.options.logs.error("Subagent sessions", error)
        if (this.destroyed || this.modal) return
      }
    }
    this.showModal(new SubagentSessionModal(this.renderer, {
      sessions,
      currentId: null,
      onSelect: (sessionId) => {
        this.selectSession(sessionId)
        this.closeModal()
      },
      onClose: () => this.closeModal(),
    }))
  }

  /** Moves between a parent's worker transcripts without opening the worker picker. */
  private async cycleSubagent(direction: -1 | 1): Promise<void> {
    const selected = this.selectedSession()
    if (!selected) return
    const parentId = selected.parentSessionId ?? selected.id
    try {
      const children = await this.options.chats.children(parentId)
      if (this.destroyed || children.length === 0) return
      for (const child of children) this.rememberSession(child)

      const current = children.findIndex((child) => child.id === selected.id)
      const next = current < 0
        ? (direction === 1 ? children[0] : children.at(-1))
        : children[(current + direction + children.length) % children.length]
      if (next) this.selectSession(next.id)
    } catch (error) {
      this.options.logs.error("Subagent sessions", error)
    }
  }

  /** Every key, on ^G: the status line names this instead of listing them. */
  private openHelp(): void {
    if (this.modal || this.destroyed) return
    this.showModal(new ChatHelpModal(this.renderer, { onClose: () => this.closeModal() }))
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
   * The current chat changes immediately, while the same choice becomes the default
   * for chats created later. Other open chats keep their own model, so comparisons do
   * not move underneath the trader. Opening the picker with no chat yet starts one, so
   * choosing a model is never blocked on having something to say.
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
        const preferences = await account.preferences()
        await account.setPreferences({ ...preferences, chat: choice })
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
    this.setSelectedSession(sessionId)
    if (!this.messagesBySession.has(sessionId)) void this.loadSession(sessionId)
    this.render.schedule()
  }

  private initialSession(sessions: ChatSession[]): string | null {
    const preferred = this.options.initialSessionId
    return sessions.some((session) => session.id === preferred) ? (preferred ?? null) : (sessions[0]?.id ?? null)
  }

  private setSelectedSession(sessionId: string | null): void {
    if (sessionId === this.selectedSessionId) return
    this.selectedSessionId = sessionId
    this.options.onSessionChange?.(sessionId)
  }

  private toggleThoughts(): void {
    this.showThoughts = !this.showThoughts
    this.options.onShowThoughtsChange?.(this.showThoughts)
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
    this.syncSpinner(session)
    this.transcript.setBlocks(this.transcriptBlocks(session))
    this.composerRow.visible = this.composerUsable()
    // Nothing here sizes the field: it measures its own text and the block around it
    // takes exactly the height the prompt needs. Only the active insertion marker is
    // warm; when the transcript has focus it recedes with the other turn markers.
    this.composerMarker.fg = this.typing() ? COMPOSER_COLOR : TURN_MARKER_COLOR
    this.composerMeta.content = this.composerMetaText(session)
    this.composerMeta.visible = this.composerUsable()
    this.hint.content = this.hintText(session)
    this.usage.content = this.usageText(session)
    // Session pickers stay live while a reply lands or a worker finishes.
    if (this.modal instanceof ChatSessionModal) {
      this.modal.setSessions(
        this.sessions.filter((candidate) => candidate.parentSessionId === null),
        this.selectedSessionId,
      )
    }
    if (this.modal instanceof SubagentSessionModal) {
      const parentId = session?.id
      this.modal.setSessions(
        this.sessions.filter((candidate) => candidate.parentSessionId === parentId),
        null,
      )
    }
    this.renderer.requestRender()
  }

  /** What will answer what is being typed. */
  private composerMetaText(session: ChatSession | null): StyledText {
    if (!session?.model) return new StyledText([fg(QUEUED_COLOR)("no model · ^O chooses one")])
    if (session.parentSessionId) {
      return new StyledText([
        fg(MODEL_COLOR)(session.agent ?? "worker"),
        fg(FAINT_COLOR)(" · "),
        ...modelLabel(session.model, session.reasoning).chunks,
      ])
    }
    return modelLabel(session.model, session.reasoning)
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

  /**
   * The keys, or what stands in the way of using them.
   *
   * While a root reply is running the list leads with the key that stops it. A child
   * transcript instead keeps its navigation commands visible because its lifetime is
   * owned by the parent's tool call.
   */
  private hintText(session: ChatSession | null): string {
    if (this.connected === false) return CONNECT_HINT
    if (!this.selectedHasModel()) return NO_MODEL_HINT
    if (session?.parentSessionId) {
      const state = this.streamingBySession.has(session.id) ? "Subagent running" : "Subagent transcript"
      return `${state} · ⌥←/→ workers · ⌥↑ parent`
    }
    if (session && this.streamingBySession.has(session.id)) return RUNNING_HINT
    return CHAT_HINT
  }

  /**
   * What this conversation has used: the context it is carrying, and what it has cost.
   *
   * The context is the last reply's own token count, because a request carries the whole
   * conversation — that number is the size of the conversation, not of one message. The
   * cost is every reply added up, and is zero on a subscription, which is why nothing is
   * shown rather than `$0.00`.
   */
  private usageText(session: ChatSession | null): StyledText {
    if (!session) return new StyledText([fg(MUTED_COLOR)("")])
    const messages = this.messagesBySession.get(session.id) ?? []
    const context = messages.reduce<number | null>(
      (last, message) => (message.role === "ASSISTANT" && message.usage ? message.usage.totalTokens : last),
      null,
    )
    const cost = messages.reduce((total, message) => total + (message.usage?.costTotal ?? 0), 0)
    const parts: string[] = []
    if (context !== null) {
      const window = this.contextWindows.get(`${session.provider}/${session.model}`)
      const share = window && window > 0 ? ` (${Math.round((context / window) * 100)}%)` : ""
      parts.push(`${formatTokens(context)}${share}`)
    }
    if (cost > 0) parts.push(formatCost(cost))
    return new StyledText([fg(MUTED_COLOR)(parts.join(" · "))])
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
    const blocks = (this.messagesBySession.get(session.id) ?? [])
      .map((message) => messageBlock(message, current, this.showThoughts))
    const streaming = this.streamingBySession.get(session.id)
    if (streaming) {
      blocks.push(streamingBlock(streaming, current, {
        spinner: SPINNER_FRAMES[this.spinner] ?? SPINNER_FRAMES[0]!,
        elapsedMs: streaming.startedAt === null ? null : Date.now() - streaming.startedAt,
        showThoughts: this.showThoughts,
      }))
    }
    if (blocks.length === 0) return [note("Nothing said yet.")]
    return blocks
  }
}

/**
 * A message as a turn in the transcript.
 *
 * A prompt is a filled block with a chevron. A reply remains on the page with only a
 * muted bullet, leaving the answer visually lighter than the request that started it.
 */
function messageBlock(message: ChatMessage, current: StyledText, showThoughts: boolean): ChatTranscriptBlock {
  if (message.role === "APP_EVENT") {
    return {
      id: message.id,
      marker: new StyledText([fg(COMPOSER_COLOR)("◆")]),
      header: new StyledText([fg(COMPOSER_COLOR)("price alert")]),
      content: new StyledText([fg(MUTED_COLOR)(message.text)]),
      ...(message.status === "QUEUED"
        ? { footer: new StyledText([fg(QUEUED_COLOR)("waiting for agent")]) }
        : message.status === "FAILED"
          ? { footer: new StyledText([fg(ERROR_COLOR)("agent wake-up failed")]) }
          : {}),
    }
  }
  if (message.role === "USER") {
    const queued = message.status === "QUEUED"
    return {
      id: message.id,
      marker: new StyledText([fg(queued ? QUEUED_COLOR : TURN_MARKER_COLOR)("›")]),
      fill: PROMPT_BG,
      padded: true,
      content: new StyledText([fg(queued ? QUEUED_COLOR : TEXT_COLOR)(message.text)]),
      ...(queued
        ? { footer: new StyledText([fg(QUEUED_COLOR)("queued · ^X cancels it")]) }
        : message.status === "FAILED"
          ? { footer: new StyledText([fg(ERROR_COLOR)("failed")]) }
          : {}),
    }
  }
  if (message.role === "TOOL_RESULT") {
    return {
      id: message.id,
      marker: new StyledText([fg(message.isError ? ERROR_COLOR : TOOL_COLOR)("•")]),
      header: new StyledText([fg(MUTED_COLOR)(message.toolName ?? "tool")]),
      content: new StyledText([fg(message.isError ? ERROR_COLOR : MUTED_COLOR)(message.text)]),
    }
  }
  const chunks: TextChunk[] = []
  if (message.text) chunks.push(fg(TEXT_COLOR)(message.text))
  if (message.status === "PARTIAL") chunks.push(fg(MUTED_COLOR)(`${chunks.length > 0 ? "\n" : ""}stopped`))
  if (message.errorMessage) chunks.push(fg(ERROR_COLOR)(`${chunks.length > 0 ? "\n" : ""}${message.errorMessage}`))
  const thought = thoughtHeader(reasoningText(message), {
    showThoughts,
    thinkingMs: message.thinkingMs,
  })
  return {
    id: message.id,
    marker: new StyledText([fg(TURN_MARKER_COLOR)("•")]),
    ...(thought ? { header: thought } : {}),
    bodyVisible: chunks.length > 0,
    content: new StyledText(chunks),
    footer: signature(message, current),
  }
}

/**
 * The reply being written.
 *
 * A model can think for a long time before its first word, so the spinner turns and the
 * timer counts from the moment the run starts: a still cursor and a stalled run look
 * identical.
 */
function streamingBlock(
  streaming: Streaming,
  current: StyledText,
  live: { spinner: string; elapsedMs: number | null; showThoughts: boolean },
): ChatTranscriptBlock {
  // Still thinking: the count runs on, and the tail of the thought is the only thing
  // there is to read while it does.
  const thinking = !streaming.text
  const thinkingMs = thinking && streaming.startedAt !== null && live.elapsedMs !== null
    ? live.elapsedMs
    : streaming.thinkingMs
  const chunks: TextChunk[] = []
  if (streaming.text) chunks.push(fg(TEXT_COLOR)(streaming.text), fg(MUTED_COLOR)("▌"))
  // The tail is all a folded thought shows while it is the only thing happening.
  // Expanded reasoning already lives in the header, so repeating "thinking…" below
  // it would add noise without adding state.
  else if (streaming.reasoning) {
    if (!live.showThoughts) chunks.push(fg(REASONING_COLOR)(lastLine(streaming.reasoning)))
  }
  else chunks.push(fg(MUTED_COLOR)("thinking…"))
  for (const tool of streaming.tools) {
    chunks.push(fg(MUTED_COLOR)(`${chunks.length > 0 ? "\n" : ""}⚙ ${tool}`))
  }
  const thought = thoughtHeader(streaming.reasoning, {
    showThoughts: live.showThoughts,
    thinkingMs,
    live: thinking,
  })
  const footer: TextChunk[] = [fg(MODEL_COLOR)(`${live.spinner} `), ...current.chunks]
  if (live.elapsedMs !== null) footer.push(fg(FAINT_COLOR)(` · ${formatDuration(live.elapsedMs)}`))
  return {
    id: `streaming-${streaming.runId}`,
    marker: new StyledText([fg(TURN_MARKER_COLOR)("•")]),
    ...(thought ? { header: thought } : {}),
    bodyVisible: chunks.length > 0,
    content: new StyledText(chunks),
    footer: new StyledText(footer),
  }
}

/**
 * Which model wrote a reply, how hard it thought, how long it took and what it cost.
 *
 * Underneath the words rather than above them: the answer is what a trader came to
 * read, and its provenance is what they check afterwards.
 */
function signature(message: ChatMessage, current: StyledText): StyledText {
  const label = message.model ? modelLabel(message.model, message.reasoning) : current
  const parts: string[] = []
  if (message.elapsedMs !== null) parts.push(formatDuration(message.elapsedMs))
  if (message.usage) {
    parts.push(formatTokens(message.usage.totalTokens))
    if (message.usage.costTotal > 0) parts.push(formatCost(message.usage.costTotal))
  }
  return new StyledText([
    fg(FAINT_COLOR)("▪ "),
    ...label.chunks,
    ...(parts.length > 0 ? [fg(FAINT_COLOR)(` · ${parts.join(" · ")}`)] : []),
  ])
}

/**
 * That the model thought, how long it took over it, and what it thought when asked to
 * show it.
 *
 * Visible by default, matching the live Codex transcript. `^T` folds every thought when
 * reasoning gets in the way. The duration stays either way, because how long a model sat
 * thinking is worth knowing even when the thoughts themselves are hidden.
 */
function thoughtHeader(
  reasoning: string,
  options: { showThoughts: boolean; thinkingMs: number | null; live?: boolean },
): StyledText | null {
  const text = reasoning.trim()
  if (!text) return null
  const label = options.live ? "thinking" : "thought"
  const spent = options.thinkingMs === null ? "" : `: ${formatDuration(options.thinkingMs)}`
  if (!options.showThoughts) return new StyledText([fg(THOUGHT_COLOR)(`+ ${label}${spent}`)])
  return new StyledText([fg(THOUGHT_COLOR)(`− ${label}${spent}\n`), fg(REASONING_COLOR)(text)])
}

/** What a stored reply thought, gathered from the blocks that hold it. */
function reasoningText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.kind === "THINKING")
    .map((block) => block.text ?? "")
    .join("")
}

/**
 * What answered, and how hard it was thinking.
 *
 * Taken from the message where it recorded one, so pointing a chat at another model
 * relabels nothing that came before it.
 */
function modelLabel(model: string, reasoning: string | null): StyledText {
  const chunks: TextChunk[] = [fg(MODEL_COLOR)(model)]
  if (reasoning) chunks.push(fg(FAINT_COLOR)(` · ${reasoning}`))
  return new StyledText(chunks)
}

/** Something the screen is saying itself, so it carries no signature or role marker. */
function note(text: string): ChatTranscriptBlock {
  return { id: "note", content: new StyledText([fg(MUTED_COLOR)(text)]) }
}

/** Reasoning is long and only its tail is worth the room while it streams. */
function lastLine(reasoning: string): string {
  const lines = reasoning.split("\n").filter((line) => line.trim().length > 0)
  return lines[lines.length - 1] ?? ""
}

/** Rounded to what a trader would say out loud: "half a second", "four seconds", "a minute". */
function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${Math.max(0, Math.round(elapsedMs))}ms`
  if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(1)}s`
  const seconds = Math.round(elapsedMs / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${(tokens / 1000).toFixed(1)}K`
}

/** Fractions of a cent are the normal case for one reply, so they are not rounded away. */
function formatCost(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
}

function isControl(key: KeyEvent, letter: string): boolean {
  return Boolean(key.ctrl) && !key.meta && !key.option && key.name === letter
}

function isAltArrow(key: KeyEvent, direction: "left" | "right" | "up"): boolean {
  return Boolean(key.meta || key.option) && !key.ctrl && key.name === direction
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter"
}
