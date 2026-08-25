import { TUI_THEME } from "../theme.ts"
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
import {
  CHAT_TIMELINE_LIMIT,
  recentChatTimeline,
  type ChatMessage,
  type ChatRunStatus,
  type ChatSession,
} from "@trbot/chat/session.ts"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type {
  ChatPermissionMode,
  ChatPermissionModeState,
  ChatPermissionRequest,
} from "@trbot/chat/permission.ts"
import { parseLoopInterval, type ChatAutomationState } from "@trbot/chat/automation.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import type { MarketMonitor } from "@trbot/market/market-monitor.ts"
import type { AiAccount, AiModelChoice } from "@trbot/protocol/ai.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import type { MarketMonitorClient } from "@trbot/client/monitors.ts"
import { AiConnectionModal } from "../components/ai-connection-modal.ts"
import { AiModelModal } from "../components/ai-model-modal.ts"
import { ChatCommandMenu, type ChatCommand } from "../components/chat-command-menu.ts"
import { ChatHelpModal } from "../components/chat-help-modal.ts"
import { ChatMobileModal } from "../components/chat-mobile-modal.ts"
import { ChatQuestionPanel } from "../components/chat-question-panel.ts"
import { ChatPermissionPanel } from "../components/chat-permission-panel.ts"
import { ChatPermissionModeModal } from "../components/chat-permission-mode-modal.ts"
import { ChatSessionModal } from "../components/chat-session-modal.ts"
import { ChatTranscript, type ChatTranscriptBlock } from "../components/chat-transcript.ts"
import { ChatUndoPanel } from "../components/chat-undo-panel.ts"
import { MarketMonitorModal } from "../components/market-monitor-modal.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
import type { SoundPlayer } from "../components/sound.ts"
import { SubagentSessionModal } from "../components/subagent-session-modal.ts"
import type { ApplicationLog } from "../logging/application-log.ts"

const BACKGROUND = TUI_THEME.appBackground
const PANEL_BG = TUI_THEME.appBackground
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const FAINT_COLOR = TUI_THEME.textDim
const REASONING_COLOR = TUI_THEME.reasoning
const THOUGHT_COLOR = TUI_THEME.thought
const QUEUED_COLOR = TUI_THEME.queued
const ERROR_COLOR = TUI_THEME.negative
const MODEL_COLOR = TUI_THEME.modelAccent
const MONITOR_COLOR = TUI_THEME.monitorAccent
const LOOP_COLOR = TUI_THEME.warning
const MANUAL_PERMISSION_COLOR = TUI_THEME.warning
const AUTO_PERMISSION_COLOR = TUI_THEME.positive
const TOOL_COLOR = TUI_THEME.tool
const PROMPT_BG = TUI_THEME.promptBackground
const CLOSED_PROMPT_BG = TUI_THEME.promptClosedBackground
const TURN_MARKER_COLOR = TUI_THEME.turnMarker
/** Full-screen prompts share one graphite surface; embedded prompts use a rail. */
const COMPOSER_BG = PROMPT_BG
const COMPOSER_COLOR = TUI_THEME.composer

/**
 * One set of keys: control keys, so they work mid-sentence and there is nothing to
 * switch between. They are listed in the help modal rather than along the bottom, and
 * `/help` is the only one the screen names for itself.
 *
 * The model picker is ^O rather than the ^M its name asks for, because Ctrl+M and
 * Return are the same byte and only a terminal that disambiguates them can tell them
 * apart — where one does not, ^M sends the message instead of opening the picker.
 * ^O is also clear of the field's own editing keys, which take ^A ^E ^F ^B ^W ^K ^U ^D.
 */
const CHAT_HINT = "/help keys"
const RUNNING_HINT = "Esc interrupt · /help keys"
const CONNECT_HINT = "No model provider connected · ^P to connect one"
const NO_MODEL_HINT = "No model chosen for this chat · ^O to choose one"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL_MS = 120
const MARKET_MONITOR_MUTATIONS = new Set([
  "create_market_monitor",
  "update_market_monitor",
  "set_market_monitor_status",
  "cancel_market_monitor",
])
const GOAL_MUTATIONS = new Set(["create_goal", "update_goal"])
const LOOP_MUTATIONS = new Set([
  "create_loop",
  "cancel_loop",
  "reschedule_loop",
])

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
const DOUBLE_ESCAPE_MS = 600

const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "/model", description: "choose which model answers this chat" },
  { name: "/permissions", description: "choose how sensitive tools are approved" },
  { name: "/reasoning", description: "choose the model's reasoning effort" },
  { name: "/thoughts", description: "show or hide model reasoning" },
  { name: "/monitors", description: "view or cancel this chat's market monitors" },
  { name: "/compact", description: "summarize this chat's model context now" },
  { name: "/goal", description: "<objective> · pause · resume · clear" },
  { name: "/loop", description: "[interval] [task] · list · cancel <id>" },
  { name: "/subagents", description: "open this chat's worker sessions" },
  { name: "/parent", description: "return from a worker transcript" },
  { name: "/sessions", description: "open another session" },
  { name: "/undo", description: "return to an earlier prompt" },
  { name: "/clear", description: "start fresh; keep this session saved" },
  { name: "/new", description: "start fresh; keep this session saved" },
  { name: "/connect", description: "continue this chat on Telegram" },
  { name: "/disconnect", description: "stop continuing this chat on Telegram" },
  { name: "/providers", description: "manage model providers" },
  { name: "/help", description: "show every chat key" },
]

type MobileCommandName = "/connect" | "/disconnect"

function visibleChatCommands(mobileCommand: MobileCommandName | null): readonly ChatCommand[] {
  return CHAT_COMMANDS.filter((command) => {
    if (command.name !== "/connect" && command.name !== "/disconnect") return true
    return command.name === mobileCommand
  })
}

type Focus = "transcript" | "composer" | "question" | "permission"
type Modal =
  | AiConnectionModal
  | AiModelModal
  | ChatSessionModal
  | ChatHelpModal
  | ChatMobileModal
  | ChatPermissionModeModal
  | ChatUndoPanel
  | MarketMonitorModal
  | SubagentSessionModal

export interface ChatScreenOptions {
  chats: ChatSessions
  /** Fit inside a parent panel instead of claiming the full workspace height. */
  embedded?: boolean
  marketMonitors?: MarketMonitorClient
  account?: AiAccount
  sound?: SoundPlayer
  logs: ApplicationLog
  /**
   * A session id restores that chat, null restores a blank chat, and undefined falls
   * back to the newest available chat.
   */
  initialSessionId?: string | null
  initialShowThoughts?: boolean
  onSessionChange?: (sessionId: string | null) => void
  onShowThoughtsChange?: (showThoughts: boolean) => void
  onQuestionPending?: (request: ChatQuestionRequest, selected: boolean) => void
  onQuestionResolved?: (requestId: string) => void
  onPermissionPending?: (request: ChatPermissionRequest, selected: boolean) => void
  onPermissionResolved?: (requestId: string) => void
  onNotification?: (notification: ChatNotification) => void
  onNotificationDismissed?: (notificationId: string) => void
  onContractSelect?: (symbol: string) => void
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
  private readonly emptyState: BoxRenderable
  private readonly commandMenu: ChatCommandMenu
  private readonly composerRow: BoxRenderable
  private readonly composerMarker: TextRenderable
  private readonly composer: TextareaRenderable
  private readonly undoSlot: BoxRenderable
  private readonly questionSlot: BoxRenderable
  private readonly composerMeta: TextRenderable
  private readonly hint: TextRenderable
  private readonly usage: TextRenderable
  private readonly render: RenderCoalescer
  private readonly surfaceBackground: string

  private sessions: ChatSession[] = []
  private messagesBySession = new Map<string, ChatMessage[]>()
  private streamingBySession = new Map<string, Streaming>()
  private runningRunIds = new Set<string>()
  private pendingQuestions = new Map<string, ChatQuestionRequest>()
  private questionPanel: ChatQuestionPanel | null = null
  private pendingPermissions = new Map<string, ChatPermissionRequest>()
  private permissionPanel: ChatPermissionPanel | null = null
  private permissionModeByRootSession = new Map<string, ChatPermissionMode>()
  private changingPermissionMode = false
  private armedMonitorCountBySession = new Map<string, number>()
  private activeLoopCountBySession = new Map<string, number>()
  private mobileConnectedBySession = new Map<string, boolean>()
  private contractByMention = new Map<string, string>()
  /** Context window per `provider/model`, for reading a conversation's usage as a share of it. */
  private contextWindows = new Map<string, number>()
  /** The model a blank chat will receive when its first prompt creates the session. */
  private defaultChoice: AiModelChoice | null = null
  private selectedSessionId: string | null = null
  private focus: Focus = "composer"
  private connected: boolean | null = null
  private modal: Modal | null = null
  private undoPanel: ChatUndoPanel | null = null
  /** Whether replies show the reasoning that led to them, or only that there was some. */
  private showThoughts: boolean
  private commandNotice: string | null = null
  private automationNotice: "goal" | "loop" | null = null
  private compactingSessionId: string | null = null
  private spinner = 0
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private marketOpen: boolean | null = null
  private modalHost: BoxRenderable
  /** Prevents session-list refreshes from reopening the chat the user just left. */
  private awaitingFirstPrompt = false
  private lastEscapeAt = 0
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatScreenOptions,
  ) {
    this.render = new RenderCoalescer(
      () => this.paint(),
      (error) => options.logs.error("Chat renderer", error),
    )
    this.surfaceBackground = options.embedded ? TUI_THEME.panelBackground : PANEL_BG
    this.selectedSessionId = options.initialSessionId ?? null
    // An explicit null is the saved blank-chat state. Undefined means preferences
    // were unavailable, in which case load() may safely fall back to a real session.
    this.awaitingFirstPrompt = options.initialSessionId === null
    this.showThoughts = options.initialShowThoughts ?? true
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      ...(options.embedded ? { flexGrow: 1 } : { height: "100%" as const }),
      flexDirection: "column",
      backgroundColor: options.embedded ? this.surfaceBackground : BACKGROUND,
      onSizeChange: () => this.render.schedule(),
    })
    this.modalHost = this.root

    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      paddingLeft: CHAT_INSET,
      paddingRight: CHAT_INSET,
      backgroundColor: this.surfaceBackground,
    })
    this.transcript = new ChatTranscript(renderer, {
      backgroundColor: this.surfaceBackground,
      resolveContractSymbol: (mention) => this.contractByMention.get(mention) ?? null,
      onContractSelect: options.onContractSelect,
      onBlockSelect: (messageId) => this.openUndo(messageId),
    })
    this.emptyState = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: this.surfaceBackground,
      visible: false,
    })
    this.emptyState.add(new TextRenderable(renderer, {
      content: new StyledText([
        fg(TEXT_COLOR)("New chat"),
        fg(MUTED_COLOR)("\n\nAsk about a market, investigate a move, or work through a trade."),
        fg(COMPOSER_COLOR)("\n\n/"),
        fg(FAINT_COLOR)("  commands     "),
        fg(COMPOSER_COLOR)("^S"),
        fg(FAINT_COLOR)("  sessions"),
      ]),
      width: "80%",
      maxWidth: 58,
      wrapMode: "word",
    }))
    body.add(this.transcript.root)
    body.add(this.emptyState)
    this.commandMenu = new ChatCommandMenu(renderer, visibleChatCommands("/connect"), {
      backgroundColor: this.surfaceBackground,
    })

    const composerBackground = options.embedded ? this.surfaceBackground : COMPOSER_BG
    // The next prompt matches sent prompts: filled in the full chat, or carried by
    // a compact left rail in the trade panel.
    this.composerRow = new BoxRenderable(renderer, {
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: options.embedded ? 1 : 0,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
      marginTop: 1,
      marginLeft: CHAT_INSET,
      marginRight: CHAT_INSET,
      backgroundColor: composerBackground,
    })
    if (options.embedded) {
      this.composerRow.border = ["left"]
      this.composerRow.borderColor = COMPOSER_COLOR
      this.composerRow.borderStyle = "heavy"
    }
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
      backgroundColor: composerBackground,
      focusedBackgroundColor: composerBackground,
      textColor: TEXT_COLOR,
    })
    if (!options.embedded) this.composerRow.add(this.composerMarker)
    this.composerRow.add(this.composer)
    this.undoSlot = new BoxRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    })
    this.questionSlot = new BoxRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    })

    // Model, keys and usage form one quiet status line below the field, as in Codex.
    const composerDetails = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 2,
      // The model starts under the prompt text, after its inset and marker.
      paddingLeft: CHAT_INSET + 2,
      paddingRight: CHAT_INSET,
      backgroundColor: this.surfaceBackground,
    })
    this.composerMeta = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      flexShrink: 0,
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
    this.root.add(this.undoSlot)
    this.root.add(this.questionSlot)
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
    if (!this.selectedSessionId) void this.loadDefaultChoice()
    else void this.refreshMobileConnection(this.selectedSessionId)
  }

  /** A hidden textarea must neither draw a cursor nor receive another panel's keys. */
  deactivate(): void {
    this.composer.blur()
  }

  setMarketOpen(open: boolean | null): void {
    if (this.destroyed || this.marketOpen === open) return
    this.marketOpen = open
    const background = this.options.embedded
      ? this.surfaceBackground
      : open === false ? CLOSED_PROMPT_BG : COMPOSER_BG
    this.composerRow.backgroundColor = background
    this.composer.backgroundColor = background
    this.composer.focusedBackgroundColor = background
    this.render.schedule()
  }

  /** Links an active contract's full symbol and underlying ticker to that contract. */
  setContractInstruments(instruments: readonly ViopInstrument[]): void {
    if (this.destroyed) return
    const next = new Map<string, string>()
    for (const instrument of instruments) {
      next.set(instrument.symbol.toUpperCase(), instrument.symbol)
      if (instrument.underlyingSymbol) {
        next.set(instrument.underlyingSymbol.toUpperCase(), instrument.symbol)
      }
    }
    if (
      next.size === this.contractByMention.size
      && [...next].every(([mention, symbol]) => this.contractByMention.get(mention) === symbol)
    ) return
    this.contractByMention = next
    this.render.schedule()
  }

  /** Keeps multiple views of chat on the same reasoning-visibility preference. */
  setShowThoughts(showThoughts: boolean): void {
    if (this.destroyed || this.showThoughts === showThoughts) return
    this.showThoughts = showThoughts
    this.render.schedule()
  }

  /**
   * The composer takes letters, so while it holds focus the tab shortcuts must
   * not: typing "Tomorrow" would otherwise leave the tab.
   */
  capturesInput(): boolean {
    return this.typing()
      || this.undoPanel !== null
      || this.focus === "question"
      || this.focus === "permission"
      || this.modal !== null
  }

  /** Whether an embedded composer can hand Escape back to its host panel. */
  canReleaseFocus(): boolean {
    const session = this.selectedSession()
    return this.undoPanel === null
      && this.focus === "composer"
      && this.commandNotice === null
      && (!session || !this.streamingBySession.has(session.id))
  }

  /** Lets an embedded chat center its popups over the screen that contains it. */
  setModalHost(host: BoxRenderable): void {
    if (this.destroyed || this.modalHost === host) return
    const modalRoot = this.modal?.root
    if (modalRoot && !modalRoot.isDestroyed) {
      if (!this.modalHost.isDestroyed) this.modalHost.remove(modalRoot)
      host.add(modalRoot)
    }
    this.modalHost = host
    this.renderer.requestRender()
  }

  hasOpenModal(): boolean {
    return this.modal !== null
  }

  handleKey(key: KeyEvent): void {
    if (this.destroyed) return
    // This screen routes every key itself, including the ones it hands to the composer.
    // The composer is a focused renderable, so the terminal would deliver the same key
    // to the field a second time and every character would land twice — marking it
    // handled here is what keeps the field's own delivery from doubling ours. The same
    // holds while a modal is up: a modal may focus its own field and route the key
    // itself, so renderer delivery would otherwise type every character twice.
    key.preventDefault()
    if (this.modal) {
      this.lastEscapeAt = 0
      this.modal.handleKey(key)
      return
    }
    if (this.undoPanel) {
      this.lastEscapeAt = 0
      this.undoPanel.handleKey(key)
      return
    }
    if (this.focus === "question" && this.questionPanel) {
      this.lastEscapeAt = 0
      this.questionPanel.handleKey(key)
      return
    }
    if (isShiftTab(key)) {
      this.lastEscapeAt = 0
      void this.togglePermissionMode()
      return
    }
    if (this.focus === "permission" && this.permissionPanel) {
      this.lastEscapeAt = 0
      this.permissionPanel.handleKey(key)
      return
    }
    if (key.name !== "escape" && key.name !== "esc") this.lastEscapeAt = 0
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
      this.startNewChat()
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
    // One Escape still interrupts. A second, while idle, opens the same undo picker
    // as /undo; keeping the presses close prevents an old Escape from firing later.
    if (key.name === "escape" || key.name === "esc") {
      const selectedId = this.selectedSessionId ?? ""
      const replying = this.selectedSession()?.running || this.streamingBySession.has(selectedId)
      if (this.commandNotice && !replying) {
        this.commandNotice = null
        this.automationNotice = null
        this.lastEscapeAt = 0
        this.render.schedule()
        return
      }
      const now = Date.now()
      const doubleEscape = this.lastEscapeAt > 0 && now - this.lastEscapeAt <= DOUBLE_ESCAPE_MS
      this.lastEscapeAt = doubleEscape ? 0 : now
      if (doubleEscape && !this.selectedSession()?.running && !this.streamingBySession.has(this.selectedSessionId ?? "")) {
        this.openUndo()
        return
      }
      void this.stopReply()
      return
    }
    if (key.name === "tab" || key.name === "backtab") {
      if (this.typing()) this.setFocus(this.blockingFocus() ?? "transcript")
      else this.setFocus("composer")
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
    this.closeUndo()
    this.removeQuestionPanel()
    this.removePermissionPanel()
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
    // A fresh socket starts with this authoritative snapshot. If the server was
    // restarted mid-turn, there is no terminal run frame to retire the old local
    // stream, so settle root sessions the snapshot says are idle.
    for (const session of sessions) {
      if (session.running) continue
      const stale = this.streamingBySession.get(session.id)
      if (stale) this.runningRunIds.delete(stale.runId)
      this.streamingBySession.delete(session.id)
    }
    if (
      !this.awaitingFirstPrompt
      && (!this.selectedSessionId || !this.sessions.some((session) => session.id === this.selectedSessionId))
    ) {
      this.setSelectedSession(this.initialSession(sessions))
      if (this.selectedSessionId) {
        void this.loadSession(this.selectedSessionId)
      }
    }
    // Child sessions are intentionally absent from the root snapshot. Re-read a
    // selected child so a server restart also settles its orphaned spinner.
    const selected = this.selectedSession()
    if (selected?.parentSessionId) void this.loadSession(selected.id)
    this.render.schedule()
  }

  acceptMessage(sessionId: string, message: ChatMessage): void {
    if (this.destroyed) return
    const messages = this.messagesBySession.get(sessionId) ?? []
    const existing = messages.findIndex((entry) => entry.id === message.id)
    if (existing >= 0) messages[existing] = message
    else messages.push(message)
    this.messagesBySession.set(sessionId, recentChatTimeline(messages, CHAT_TIMELINE_LIMIT))
    // A stored reply replaces what was streaming, so the words are not shown twice.
    if (message.role === "ASSISTANT") this.streamingBySession.delete(sessionId)
    // A tool result is also its completion signal. Keep only calls still in flight in
    // the live status list; the stored result remains visible in the transcript.
    else if (existing < 0 && message.role === "TOOL_RESULT" && message.toolName) {
      const streaming = this.streamingBySession.get(sessionId)
      const toolIndex = streaming?.tools.indexOf(message.toolName) ?? -1
      if (streaming && toolIndex >= 0) streaming.tools.splice(toolIndex, 1)
    }
    if (message.role === "APP_EVENT" || (message.toolName && MARKET_MONITOR_MUTATIONS.has(message.toolName))) {
      void this.refreshMarketMonitorCount(sessionId)
    }
    const goalChanged = (message.role === "APP_EVENT" && message.toolName === "goal")
      || (message.role === "TOOL_RESULT" && message.toolName !== null && GOAL_MUTATIONS.has(message.toolName))
    if (goalChanged) {
      void this.refreshAutomationNotice(sessionId)
    }
    const loopChanged = (message.role === "APP_EVENT" && message.toolName === "loop")
      || (message.role === "TOOL_RESULT" && message.toolName !== null && LOOP_MUTATIONS.has(message.toolName))
    if (loopChanged) {
      if (sessionId === this.selectedSessionId && this.automationNotice === "loop") {
        this.automationNotice = null
        this.commandNotice = null
      }
      void this.refreshActiveLoopCount(sessionId)
    }
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

  acceptRun(sessionId: string, runId: string, status: ChatRunStatus, error?: string): void {
    if (this.destroyed) return
    const wasRunning = status === "running" ? false : this.runningRunIds.delete(runId)
    if (status !== "running") this.streamingBySession.delete(sessionId)
    // A run announces itself before its first delta, and a model can think for a long
    // while before that one arrives: holding the run from here is what makes the
    // spinner turn from the moment the question went rather than from the answer.
    else if (this.streamingBySession.get(sessionId)?.runId !== runId) {
      this.streamingBySession.set(sessionId, { runId, startedAt: Date.now(), thinkingMs: null, text: "", reasoning: "", tools: [] })
    }
    if (status === "running") this.runningRunIds.add(runId)
    const session = this.sessions.find((candidate) => candidate.id === sessionId)
    // A worker finishing is only one step inside its parent's turn. The parent
    // completion is the single user-facing event worth sounding.
    if (
      wasRunning
      && (status === "done" || status === "failed")
      && session?.parentSessionId === null
    ) {
      this.options.sound?.play("COMPLETE")
    }
    if (error) this.options.logs.error("Chat", new Error(error))
    this.sessions = this.sessions.map((session) => (
      session.id === sessionId ? { ...session, running: status === "running" } : session
    ))
    this.render.schedule()
  }

  acceptQuestion(request: ChatQuestionRequest): void {
    if (this.destroyed) return
    const isNew = !this.pendingQuestions.has(request.id)
    this.pendingQuestions.set(request.id, request)
    if (!isNew) return
    if (request.sessionId === this.selectedSessionId) this.setFocus(this.blockingFocus() ?? "question")
    this.options.onQuestionPending?.(request, request.sessionId === this.selectedSessionId)
    this.render.schedule()
  }

  acceptQuestionResolved(_sessionId: string, requestId: string): void {
    if (this.destroyed) return
    this.finishQuestion(requestId)
  }

  acceptPermission(request: ChatPermissionRequest): void {
    if (this.destroyed) return
    const isNew = !this.pendingPermissions.has(request.id)
    this.pendingPermissions.set(request.id, request)
    if (!isNew) return
    if (request.sessionId === this.selectedSessionId) this.setFocus("permission")
    this.options.onPermissionPending?.(request, request.sessionId === this.selectedSessionId)
    this.render.schedule()
  }

  acceptPermissionResolved(_sessionId: string, requestId: string): void {
    if (this.destroyed) return
    this.finishPermission(requestId)
  }

  acceptPermissionMode(state: ChatPermissionModeState): void {
    if (this.destroyed) return
    this.permissionModeByRootSession.set(state.sessionId, state.mode)
    this.render.schedule()
  }

  acceptNotification(notification: ChatNotification): void {
    if (this.destroyed) return
    this.options.onNotification?.(notification)
  }

  acceptNotificationDismissed(notificationId: string): void {
    if (this.destroyed) return
    this.options.onNotificationDismissed?.(notificationId)
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
      const [sessions, questions, permissions, notifications] = await Promise.all([
        this.options.chats.list(),
        this.options.chats.questions(),
        this.options.chats.permissions(),
        this.options.chats.notifications(),
      ])
      if (this.destroyed) return
      this.sessions = sessions
      for (const request of questions) {
        if (this.pendingQuestions.has(request.id)) continue
        this.pendingQuestions.set(request.id, request)
        this.options.onQuestionPending?.(request, request.sessionId === this.selectedSessionId)
      }
      for (const request of permissions) {
        if (this.pendingPermissions.has(request.id)) continue
        this.pendingPermissions.set(request.id, request)
        this.options.onPermissionPending?.(request, request.sessionId === this.selectedSessionId)
      }
      for (const notification of notifications) this.options.onNotification?.(notification)
      const preferred = this.options.initialSessionId
      if (preferred && !sessions.some((session) => session.id === preferred)) {
        try {
          this.rememberSession((await this.options.chats.get(preferred)).session)
        } catch {
          // The saved child may have been deleted with its parent; the root fallback below is valid.
        }
      }
      if (!this.awaitingFirstPrompt) this.setSelectedSession(this.initialSession(this.sessions))
      const blocking = this.blockingFocus()
      if (blocking) this.setFocus(blocking)
      if (this.selectedSessionId) {
        await Promise.all([
          this.loadSession(this.selectedSessionId),
          this.refreshMarketMonitorCount(this.selectedSessionId),
          this.refreshActiveLoopCount(this.selectedSessionId),
          this.refreshMobileConnection(this.selectedSessionId),
          this.refreshPermissionMode(this.selectedSessionId),
        ])
      }
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
      // Keep this guard even though the HTTP client requests the same window. It
      // protects the renderer while a newer TUI is connected to an older server.
      this.messagesBySession.set(sessionId, recentChatTimeline(detail.messages, CHAT_TIMELINE_LIMIT))
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
        const stale = this.streamingBySession.get(sessionId)
        if (stale) this.runningRunIds.delete(stale.runId)
        this.streamingBySession.delete(sessionId)
      }
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat", error)
    }
  }

  private async refreshMarketMonitorCount(sessionId: string): Promise<void> {
    const service = this.options.marketMonitors
    if (!service) return
    try {
      const monitors = await service.list(sessionId)
      if (this.destroyed) return
      this.armedMonitorCountBySession.set(
        sessionId,
        monitors.filter((monitor) => monitor.status === "ARMED").length,
      )
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Market monitors", error)
    }
  }

  private async refreshAllMarketMonitorCounts(): Promise<void> {
    const service = this.options.marketMonitors
    if (!service) return
    try {
      const monitors = await service.list()
      if (this.destroyed) return
      const counts = new Map<string, number>()
      for (const monitor of monitors) {
        if (monitor.status !== "ARMED") continue
        counts.set(monitor.chatSessionId, (counts.get(monitor.chatSessionId) ?? 0) + 1)
      }
      this.armedMonitorCountBySession = counts
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Market monitors", error)
    }
  }

  private async refreshAllActiveLoopCounts(): Promise<void> {
    const sessions = this.sessions.filter((session) => session.parentSessionId === null)
    try {
      const states = await Promise.all(sessions.map(async (session) => ({
        sessionId: session.id,
        state: await this.options.chats.automations(session.id),
      })))
      if (this.destroyed) return
      const counts = new Map<string, number>()
      for (const { sessionId, state } of states) {
        const count = state.loops.filter((loop) => loop.status === "ACTIVE").length
        if (count > 0) counts.set(sessionId, count)
      }
      this.activeLoopCountBySession = counts
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat loops", error)
    }
  }

  private async refreshActiveLoopCount(sessionId: string): Promise<void> {
    try {
      const state = await this.options.chats.automations(sessionId)
      if (this.destroyed) return
      this.rememberActiveLoopCount(sessionId, state)
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat loops", error)
    }
  }

  private rememberActiveLoopCount(sessionId: string, state: ChatAutomationState): void {
    const count = state.loops.filter((loop) => loop.status === "ACTIVE").length
    if (count > 0) this.activeLoopCountBySession.set(sessionId, count)
    else this.activeLoopCountBySession.delete(sessionId)
  }

  private async refreshAutomationNotice(sessionId: string): Promise<void> {
    const focus = this.automationNotice
    if (!focus || sessionId !== this.selectedSessionId) return
    try {
      const state = await this.options.chats.automations(sessionId)
      if (this.destroyed || sessionId !== this.selectedSessionId || focus !== this.automationNotice) return
      this.commandNotice = formatAutomations(state, focus)
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat automation", error)
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
      if (this.connected) {
        await Promise.all([
          this.loadContextWindows(),
          this.loadDefaultChoice(),
        ])
      }
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

  /** Refreshes what a not-yet-persisted chat will use without creating the chat. */
  private async loadDefaultChoice(): Promise<void> {
    const account = this.options.account
    if (!account) return
    try {
      this.defaultChoice = (await account.preferences()).chat
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Model preference", error)
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
    if (this.composer.plainText === "/" && this.selectedSessionId) {
      void this.refreshMobileConnection(this.selectedSessionId)
    }
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
      this.commandNotice = null
      this.automationNotice = null
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

  /** Slash commands invoke application controls without becoming user messages or consuming model tokens. */
  private async runCommand(text: string): Promise<boolean> {
    const [head = "", ...words] = text.trim().split(/\s+/u)
    const command = head.toLowerCase()
    if (!CHAT_COMMANDS.some((entry) => entry.name === command)) return false

    this.composer.setText("")
    this.commandMenu.close()
    this.render.schedule()

    switch (command) {
      case "/model":
        await this.openModelPicker("model")
        break
      case "/permissions":
        await this.openPermissionMode()
        break
      case "/reasoning":
        await this.openModelPicker("reasoning")
        break
      case "/thoughts":
        this.toggleThoughts()
        break
      case "/monitors":
        await this.openMarketMonitors()
        break
      case "/compact":
        await this.compactSession(words)
        break
      case "/goal":
        await this.runGoalCommand(words.join(" "))
        break
      case "/loop":
        await this.runLoopCommand(words.join(" "))
        break
      case "/subagents":
        await this.openSubagents()
        break
      case "/parent": {
        const parentId = this.selectedSession()?.parentSessionId
        if (parentId) this.selectSession(parentId)
        break
      }
      case "/sessions":
        this.openSessions()
        break
      case "/undo":
        if (words.length > 0) this.commandNotice = "Usage: /undo"
        else this.openUndo()
        break
      case "/clear":
      case "/new":
        this.startNewChat()
        break
      case "/connect":
        await this.openMobileConnection()
        break
      case "/disconnect":
        await this.disconnectMobileConnection()
        break
      case "/providers":
        this.openConnection()
        break
      case "/help":
        this.openHelp()
        break
    }
    this.render.schedule()
    return true
  }

  private async compactSession(arguments_: string[]): Promise<void> {
    if (arguments_.length > 0) {
      this.commandNotice = "Usage: /compact"
      return
    }
    const session = this.selectedSession()
    if (!session) {
      this.commandNotice = "Nothing to compact in this chat."
      return
    }

    try {
      this.compactingSessionId = session.id
      this.commandNotice = "Compacting context…"
      this.render.schedule()
      const compacted = await this.options.chats.compact(session.id)
      if (this.selectedSessionId === session.id) {
        this.commandNotice = compacted.compacted
          ? `Context compacted · ${formatTokens(compacted.tokensBefore)} estimated tokens summarized.`
          : "Context is already fully compacted."
      }
    } catch (error) {
      this.options.logs.error("Chat compaction", error)
      if (this.selectedSessionId === session.id) {
        this.commandNotice = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (this.compactingSessionId === session.id) this.compactingSessionId = null
      this.render.schedule()
    }
  }

  private async runGoalCommand(argumentsText: string): Promise<void> {
    this.automationNotice = "goal"
    try {
      const action = argumentsText.trim()
      const selected = this.selectedSession()
      if (!selected && (!action || ["pause", "resume", "clear"].includes(action.toLowerCase()))) {
        this.commandNotice = "No goal in this chat.\n\n/goal <objective>"
        return
      }
      const session = selected ?? await this.startSession()
      if (!session) return
      this.automationNotice = "goal"
      if (!action) {
        this.commandNotice = formatAutomations(await this.options.chats.automations(session.id), "goal")
      } else if (action.toLowerCase() === "pause") {
        await this.options.chats.updateGoal(session.id, { action: "PAUSE" })
        this.commandNotice = formatAutomations(await this.options.chats.automations(session.id), "goal")
      } else if (action.toLowerCase() === "resume") {
        await this.options.chats.updateGoal(session.id, { action: "RESUME" })
        this.commandNotice = formatAutomations(await this.options.chats.automations(session.id), "goal")
      } else if (action.toLowerCase() === "clear") {
        await this.options.chats.updateGoal(session.id, { action: "CLEAR" })
        this.commandNotice = formatAutomations(await this.options.chats.automations(session.id), "goal")
      } else {
        await this.options.chats.createGoal(session.id, { objective: action })
        this.commandNotice = formatAutomations(await this.options.chats.automations(session.id), "goal")
      }
    } catch (error) {
      this.options.logs.error("Chat goal", error)
      this.commandNotice = error instanceof Error ? error.message : String(error)
    }
  }

  private async runLoopCommand(argumentsText: string): Promise<void> {
    this.automationNotice = null
    try {
      const selected = this.selectedSession()
      const command = parseLoopCommand(argumentsText)
      if (command.action === "LIST") {
        this.automationNotice = "loop"
        if (!selected) {
          this.commandNotice = "No scheduled tasks in this chat.\n\n/loop [interval] [task]"
          return
        }
        this.commandNotice = formatAutomations(await this.options.chats.automations(selected.id), "loop")
        return
      }
      if (!selected && command.action === "CANCEL") {
        this.commandNotice = "No scheduled tasks in this chat.\n\n/loop [interval] [task]"
        return
      }
      const session = selected ?? await this.startSession()
      if (!session) return
      if (command.action === "CANCEL") {
        await this.options.chats.cancelLoop(session.id, command.loopId)
        this.commandNotice = null
        await this.refreshActiveLoopCount(session.id)
        return
      }
      await this.options.chats.createLoop(session.id, command.input)
      this.commandNotice = null
      await this.refreshActiveLoopCount(session.id)
    } catch (error) {
      this.options.logs.error("Chat loop", error)
      this.commandNotice = error instanceof Error ? error.message : String(error)
    }
  }

  /** Leaves the current chat saved and waits to persist another until its first prompt. */
  private startNewChat(): void {
    if (this.modal) this.closeModal()
    this.awaitingFirstPrompt = true
    this.composer.setText("")
    this.commandMenu.close()
    this.setSelectedSession(null)
    this.setFocus("composer")
    void this.loadDefaultChoice()
    this.render.schedule()
  }

  /** Opens a chat to hold what comes next, and selects it. */
  private async startSession(): Promise<ChatSession | null> {
    try {
      const session = await this.options.chats.create(this.defaultChoice ?? undefined)
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
      this.mobileConnectedBySession.delete(sessionId)
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
    } finally {
      // Abort is deliberately idempotent. A restarted server may have no matching
      // in-memory run, so reconcile with its durable transcript instead of waiting
      // forever for a completion frame that cannot arrive.
      await this.loadSession(sessionId)
    }
  }

  // --- transient controls -------------------------------------------------------

  /** Opens the undo picker, or a clicked prompt's confirmation choices directly. */
  openUndo(messageId?: string): void {
    if (this.modal || this.undoPanel || this.destroyed) return
    const session = this.selectedSession()
    if (!session) {
      this.commandNotice = "Nothing to undo in a new chat."
      this.render.schedule()
      return
    }
    if (session.parentSessionId) {
      this.commandNotice = "Subagent transcripts are read-only."
      this.render.schedule()
      return
    }
    const messages = this.messagesBySession.get(session.id) ?? []
    if (session.running || session.queued > 0 || messages.some((message) => message.status === "QUEUED")) {
      this.commandNotice = "Wait for this chat to finish before undoing it."
      this.render.schedule()
      return
    }
    if (!messages.some((message) => message.role === "USER" && message.status !== "QUEUED")) {
      this.commandNotice = "No completed prompt to undo."
      this.render.schedule()
      return
    }
    const selectedMessage = messageId === undefined
      ? null
      : messages.find((message) => (
          message.id === messageId && message.role === "USER" && message.status !== "QUEUED"
        )) ?? null
    if (messageId !== undefined && !selectedMessage) return

    this.commandMenu.close()
    this.composer.blur()
    const closeUndo = selectedMessage ? () => this.closeModal() : () => this.closeUndo()
    const panel = new ChatUndoPanel(this.renderer, {
      messages,
      presentation: selectedMessage ? "modal" : "inline",
      backgroundColor: this.surfaceBackground,
      loadPreview: (message) => this.options.chats.previewUndo(session.id, message.id),
      onUndo: (message, revertEffects) => {
        closeUndo()
        void this.undoTo(session.id, message.id, revertEffects)
      },
      onError: (error) => {
        this.options.logs.error("Chat undo preview", error)
        this.commandNotice = "Could not inspect this rewind point."
        this.render.schedule()
      },
      onClose: closeUndo,
    })
    if (selectedMessage) {
      panel.openMessage(selectedMessage)
      this.showModal(panel)
      return
    }
    this.undoPanel = panel
    this.undoSlot.add(panel.root)
    this.render.schedule()
  }

  private closeUndo(): void {
    const panel = this.undoPanel
    if (!panel) return
    this.undoPanel = null
    if (!this.undoSlot.isDestroyed && !panel.root.isDestroyed) this.undoSlot.remove(panel.root)
    panel.destroy()
    if (!this.destroyed && this.focus === "composer" && this.composerUsable()) this.composer.focus()
    this.render.schedule()
  }

  private async undoTo(sessionId: string, messageId: string, revertEffects: boolean): Promise<void> {
    try {
      const result = await this.options.chats.undo(sessionId, messageId, revertEffects)
      const removed = new Set(result.removedMessageIds)
      const messages = this.messagesBySession.get(sessionId) ?? []
      this.messagesBySession.set(sessionId, messages.filter((message) => !removed.has(message.id)))
      await this.loadSession(sessionId)
      if (this.destroyed || this.selectedSessionId !== sessionId) return
      this.composer.setText(result.prompt)
      this.commandMenu.setQuery(result.prompt)
      const reverted = result.revertedEffects.length
      const preserved = result.preservedEffects.length
      this.commandNotice = reverted > 0
        ? `Conversation undone; restored ${reverted} action${reverted === 1 ? "" : "s"}`
          + (preserved > 0 ? `; kept ${preserved}.` : ".")
        : preserved > 0
          ? `Conversation undone; kept ${preserved} action${preserved === 1 ? "" : "s"}.`
          : "Conversation undone."
      this.setFocus("composer")
      this.render.schedule()
    } catch (error) {
      this.options.logs.error("Chat undo", error)
      this.commandNotice = "Could not undo this conversation."
      this.render.schedule()
    }
  }

  /** The sessions, on ^S: pick one, start one, or delete one. */
  private openSessions(): void {
    if (this.modal || this.destroyed) return
    this.showModal(new ChatSessionModal(this.renderer, {
      sessions: this.sessions.filter((session) => session.parentSessionId === null),
      currentId: this.selectedSessionId,
      monitorCounts: this.armedMonitorCountBySession,
      loopCounts: this.activeLoopCountBySession,
      mobileConnections: this.mobileConnectedBySession,
      onSelect: (sessionId) => {
        this.selectSession(sessionId)
        this.closeModal()
      },
      onCreate: () => this.startNewChat(),
      // The modal stays up after a delete, so several can go in one visit; the list
      // behind it is repainted from what the server confirmed.
      onDelete: (sessionId) => void this.deleteSession(sessionId),
      onClose: () => this.closeModal(),
    }))
    void Promise.all([
      this.refreshAllMarketMonitorCounts(),
      this.refreshAllActiveLoopCounts(),
      this.refreshAllMobileConnections(),
    ])
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

  private async openMarketMonitors(): Promise<void> {
    if (this.modal || this.destroyed) return
    const sessionId = this.selectedSessionId
    let monitors: MarketMonitor[] = []
    if (sessionId && this.options.marketMonitors) {
      try {
        monitors = await this.options.marketMonitors.list(sessionId)
        this.armedMonitorCountBySession.set(
          sessionId,
          monitors.filter((monitor) => monitor.status === "ARMED").length,
        )
      } catch (error) {
        this.options.logs.error("Market monitors", error)
        if (this.destroyed || this.modal) return
      }
    }
    if (this.destroyed || this.modal) return
    this.showModal(new MarketMonitorModal(this.renderer, {
      monitors,
      onCancel: (monitorId) => void this.cancelMarketMonitor(monitorId),
      onClose: () => this.closeModal(),
    }))
  }

  private async cancelMarketMonitor(monitorId: string): Promise<void> {
    const service = this.options.marketMonitors
    if (!service) return
    try {
      await service.remove(monitorId)
      if (this.modal instanceof MarketMonitorModal) {
        const sessionId = this.selectedSessionId
        const monitors = sessionId ? await service.list(sessionId) : []
        if (sessionId) {
          this.armedMonitorCountBySession.set(
            sessionId,
            monitors.filter((monitor) => monitor.status === "ARMED").length,
          )
        }
        this.modal.setMonitors(monitors)
        this.render.schedule()
      }
    } catch (error) {
      this.options.logs.error("Market monitors", error)
    }
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

  private async openMobileConnection(): Promise<void> {
    if (this.modal || this.destroyed) return
    const session = this.selectedSession() ?? await this.startSession()
    if (!session || this.modal || this.destroyed) return
    if (session.parentSessionId) {
      this.commandNotice = "Worker transcripts cannot be connected to a phone."
      return
    }
    this.showModal(new ChatMobileModal(this.renderer, {
      chats: this.options.chats,
      sessionId: session.id,
      onConnected: (connection) => {
        this.mobileConnectedBySession.set(session.id, true)
        this.commandNotice = `Connected to Telegram · ${connection.displayName}`
        this.refreshCommandMenu()
        this.closeModal()
        this.render.schedule()
      },
      onClose: () => this.closeModal(),
    }))
  }

  private async disconnectMobileConnection(): Promise<void> {
    const session = this.selectedSession()
    if (!session) {
      this.commandNotice = "This chat is not connected to Telegram."
      return
    }
    if (session.parentSessionId) {
      this.commandNotice = "Worker transcripts cannot be connected to a phone."
      return
    }
    try {
      await this.options.chats.disconnectMobile(session.id)
      this.mobileConnectedBySession.set(session.id, false)
      this.refreshCommandMenu()
      this.commandNotice = "Disconnected from Telegram."
    } catch (error) {
      this.options.logs.error("Mobile chat", error)
      this.commandNotice = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Points this chat at a model, or at a different reasoning level.
   *
   * The current chat changes immediately, while the same choice becomes the default
   * for chats created later. Other open chats keep their own model, so comparisons do
   * not move underneath the trader. A blank chat changes only that default and remains
   * unpersisted until its first prompt.
   */
  private async openModelPicker(initial: "model" | "reasoning"): Promise<void> {
    const account = this.options.account
    if (!account || this.modal || this.destroyed) return
    const session = this.selectedSession()
    const current = session?.provider && session.model
      ? { providerId: session.provider, modelId: session.model, reasoning: session.reasoning }
      : this.defaultChoice
    this.showModal(new AiModelModal(this.renderer, {
      load: () => account.models(),
      current,
      initial,
      title: session ? "Model for this chat" : "Model for new chats",
      onChoose: async (choice) => {
        if (session) {
          const updated = await this.options.chats.configure(session.id, choice)
          this.rememberSession(updated)
        }
        this.defaultChoice = choice
        this.render.schedule()
        const preferences = await account.preferences()
        await account.setPreferences({ ...preferences, chat: choice })
      },
      onClose: () => this.closeModal(),
    }))
  }

  private async openPermissionMode(): Promise<void> {
    if (this.modal || this.destroyed) return
    const session = this.selectedSession() ?? await this.startSession()
    if (!session || this.modal || this.destroyed) return
    let current = this.permissionMode(session)
    try {
      const state = await this.options.chats.permissionMode(session.id)
      this.acceptPermissionMode(state)
      current = state.mode
    } catch (error) {
      this.options.logs.error("Chat permissions", error)
    }
    if (this.modal || this.destroyed) return
    this.showModal(new ChatPermissionModeModal(this.renderer, {
      current,
      onChoose: async (mode) => {
        await this.applyPermissionMode(session.id, mode)
        this.closeModal()
      },
      onClose: () => this.closeModal(),
    }))
  }

  private async togglePermissionMode(): Promise<void> {
    if (this.changingPermissionMode || this.destroyed || this.connected === false) return
    this.changingPermissionMode = true
    try {
      const session = this.selectedSession() ?? await this.startSession()
      if (!session || this.destroyed) return
      const current = await this.options.chats.permissionMode(session.id)
      await this.applyPermissionMode(session.id, current.mode === "MANUAL" ? "AUTO" : "MANUAL")
    } catch (error) {
      this.options.logs.error("Chat permissions", error)
      this.commandNotice = "Could not change permissions."
    } finally {
      this.changingPermissionMode = false
      if (!this.destroyed) this.render.schedule()
    }
  }

  private async applyPermissionMode(sessionId: string, mode: ChatPermissionMode): Promise<void> {
    const state = await this.options.chats.setPermissionMode(sessionId, mode)
    if (this.destroyed) return
    this.acceptPermissionMode(state)
    this.commandNotice = mode === "AUTO"
      ? "Auto permissions enabled."
      : "Manual permissions enabled."
  }

  private showModal(modal: Modal): void {
    this.modal = modal
    this.modalHost.add(modal.root)
    if ("mount" in modal) modal.mount()
    this.renderer.requestRender()
  }

  private closeModal(): void {
    const modal = this.modal
    if (!modal) return
    this.modal = null
    if (!this.modalHost.isDestroyed && !modal.root.isDestroyed) this.modalHost.remove(modal.root)
    modal.destroy()
    // Provider and mobile connection state may both have changed in a modal.
    void this.refreshConnection()
    if (this.selectedSessionId) void this.refreshMobileConnection(this.selectedSessionId)
    this.renderer.requestRender()
  }

  private finishQuestion(requestId: string): void {
    if (!this.pendingQuestions.delete(requestId)) return
    this.options.onQuestionResolved?.(requestId)
    if (this.questionPanel?.requestId === requestId) this.removeQuestionPanel()
    const blocking = this.blockingFocus()
    if (blocking) this.setFocus(blocking)
    else if (this.focus === "question") this.setFocus("composer")
    this.render.schedule()
  }

  private finishPermission(requestId: string): void {
    if (!this.pendingPermissions.delete(requestId)) return
    this.options.onPermissionResolved?.(requestId)
    if (this.permissionPanel?.requestId === requestId) this.removePermissionPanel()
    const blocking = this.blockingFocus()
    if (blocking) this.setFocus(blocking)
    else if (this.focus === "permission") this.setFocus("composer")
    this.render.schedule()
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
    void this.refreshMobileConnection(sessionId)
    void this.refreshPermissionMode(sessionId)
    const blocking = this.blockingFocus()
    if (blocking) this.setFocus(blocking)
    else if (this.focus === "question" || this.focus === "permission") this.setFocus("composer")
    this.render.schedule()
  }

  /** Opens the exact conversation where an agent is waiting for an answer. */
  openQuestion(sessionId: string): void {
    if (this.destroyed) return
    this.selectSession(sessionId)
    this.setFocus("question")
  }

  /** Opens the exact conversation where a sensitive tool is waiting. */
  openPermission(sessionId: string): void {
    if (this.destroyed) return
    this.selectSession(sessionId)
    this.setFocus("permission")
  }

  /** Opens the conversation that emitted a non-blocking notification. */
  openSession(sessionId: string): void {
    if (this.destroyed) return
    this.selectSession(sessionId)
    this.setFocus("composer")
  }

  async dismissNotification(notificationId: string): Promise<void> {
    try {
      await this.options.chats.dismissNotification(notificationId)
    } catch (error) {
      this.options.logs.error("Chat notification", error)
    }
  }

  isShowingSession(sessionId: string): boolean {
    return this.selectedSessionId === sessionId
  }

  private initialSession(sessions: ChatSession[]): string | null {
    const preferred = this.options.initialSessionId
    return sessions.some((session) => session.id === preferred) ? (preferred ?? null) : (sessions[0]?.id ?? null)
  }

  private setSelectedSession(sessionId: string | null): void {
    if (sessionId) this.awaitingFirstPrompt = false
    if (sessionId === this.selectedSessionId) return
    this.closeUndo()
    this.selectedSessionId = sessionId
    this.commandNotice = null
    this.automationNotice = null
    this.options.onSessionChange?.(sessionId)
    this.refreshCommandMenu()
    if (sessionId) {
      void this.refreshMarketMonitorCount(sessionId)
      void this.refreshActiveLoopCount(sessionId)
    }
  }

  private toggleThoughts(): void {
    this.showThoughts = !this.showThoughts
    this.options.onShowThoughtsChange?.(this.showThoughts)
    this.render.schedule()
  }

  private selectedSession(): ChatSession | null {
    return this.sessions.find((session) => session.id === this.selectedSessionId) ?? null
  }

  private async refreshMobileConnection(sessionId: string): Promise<void> {
    try {
      const state = await this.options.chats.mobile(sessionId)
      if (this.destroyed) return
      this.mobileConnectedBySession.set(sessionId, state.connection !== null)
      if (this.selectedSessionId === sessionId) this.refreshCommandMenu()
    } catch (error) {
      this.options.logs.error("Mobile chat", error)
    }
  }

  private async refreshAllMobileConnections(): Promise<void> {
    const sessions = this.sessions.filter((session) => session.parentSessionId === null)
    const connections = await Promise.all(sessions.map(async (session) => {
      try {
        const state = await this.options.chats.mobile(session.id)
        return { sessionId: session.id, connected: state.connection !== null }
      } catch (error) {
        this.options.logs.error("Mobile chat", error)
        return null
      }
    }))
    if (this.destroyed) return
    for (const connection of connections) {
      if (connection) this.mobileConnectedBySession.set(connection.sessionId, connection.connected)
    }
    if (this.selectedSessionId) this.refreshCommandMenu()
    this.render.schedule()
  }

  private refreshCommandMenu(): void {
    const session = this.selectedSession()
    const mobileCommand: MobileCommandName | null = !session
      ? "/connect"
      : session.parentSessionId
        ? null
        : this.mobileConnectedBySession.get(session.id) ? "/disconnect" : "/connect"
    this.commandMenu.setCommands(visibleChatCommands(mobileCommand), this.composer.plainText)
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
    if (focus === "composer") focus = this.blockingFocus() ?? focus
    if (this.focus === focus) return
    this.focus = focus
    if (focus === "composer" && !this.undoPanel) this.composer.focus()
    else this.composer.blur()
    this.questionPanel?.setActive(focus === "question")
    this.permissionPanel?.setActive(focus === "permission")
    this.render.schedule()
  }

  /** Whether the field is taking letters, which decides whether they are shortcuts. */
  private typing(): boolean {
    return this.undoPanel === null && this.focus === "composer" && this.composerUsable()
  }

  /** No provider or no model means there is nothing to type into yet. */
  private composerUsable(): boolean {
    return this.connected !== false && this.selectedHasModel() && this.blockingFocus() === null
  }

  // --- painting ----------------------------------------------------------------

  private paint(): void {
    if (this.destroyed) return
    const session = this.selectedSession()
    this.syncSpinner(session)
    this.transcript.setBlocks(this.transcriptBlocks(session))
    const showEmptyState = this.connected !== false && session === null
    this.emptyState.visible = showEmptyState
    this.syncQuestionPanel()
    this.syncPermissionPanel()
    this.composerRow.visible = this.composerUsable()
    // Nothing here sizes the field: it measures its own text and the block around it
    // takes exactly the height the prompt needs. Only the active insertion marker is
    // warm; when the transcript has focus it recedes with the other turn markers.
    this.composerMarker.fg = this.typing() ? COMPOSER_COLOR : TURN_MARKER_COLOR
    const composerMeta = this.composerMetaText(session)
    this.composerMeta.content = composerMeta
    this.composerMeta.visible = this.composerUsable()
    const statusWidth = Math.max(0, this.root.width - (CHAT_INSET * 2 + 2))
    const hintWidth = Math.max(0, statusWidth - styledTextWidth(composerMeta) - 2)
    const hint = this.hintText(session, hintWidth)
    this.hint.content = hint
    this.hint.visible = hint.length > 0
    this.hint.marginRight = 0
    const usage = this.usageText(session)
    this.usage.content = usage
    this.usage.visible = this.usageFits(composerMeta, hint, usage)
    // Session pickers stay live while a reply lands or a worker finishes.
    if (this.modal instanceof ChatSessionModal) {
      this.modal.setSessions(
        this.sessions.filter((candidate) => candidate.parentSessionId === null),
        this.selectedSessionId,
        this.armedMonitorCountBySession,
        this.activeLoopCountBySession,
        this.mobileConnectedBySession,
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

  private selectedPendingQuestion(): ChatQuestionRequest | null {
    for (const request of this.pendingQuestions.values()) {
      if (request.sessionId === this.selectedSessionId) return request
    }
    return null
  }

  private selectedPendingPermission(): ChatPermissionRequest | null {
    for (const request of this.pendingPermissions.values()) {
      if (request.sessionId === this.selectedSessionId) return request
    }
    return null
  }

  private blockingFocus(): "question" | "permission" | null {
    if (this.selectedPendingPermission()) return "permission"
    if (this.selectedPendingQuestion()) return "question"
    return null
  }

  private syncQuestionPanel(): void {
    if (this.selectedPendingPermission()) {
      this.removeQuestionPanel()
      return
    }
    const request = this.selectedPendingQuestion()
    if (this.questionPanel && request && this.questionPanel.requestId === request.id) {
      this.questionPanel.setActive(this.focus === "question")
      return
    }
    this.removeQuestionPanel()
    if (!request) return
    this.questionPanel = new ChatQuestionPanel(this.renderer, {
      request,
      onAnswer: async (answers) => {
        await this.options.chats.answerQuestion(request.id, answers)
        this.finishQuestion(request.id)
      },
      onFocus: () => this.setFocus("question"),
      onLeave: () => this.setFocus("transcript"),
    })
    this.questionPanel.setActive(this.focus === "question")
    this.questionSlot.add(this.questionPanel.root)
  }

  private removeQuestionPanel(): void {
    const panel = this.questionPanel
    if (!panel) return
    this.questionPanel = null
    if (!this.questionSlot.isDestroyed && !panel.root.isDestroyed) this.questionSlot.remove(panel.root)
    panel.destroy()
  }

  private syncPermissionPanel(): void {
    const request = this.selectedPendingPermission()
    if (this.permissionPanel && request && this.permissionPanel.requestId === request.id) {
      this.permissionPanel.setActive(this.focus === "permission")
      return
    }
    this.removePermissionPanel()
    if (!request) return
    this.permissionPanel = new ChatPermissionPanel(this.renderer, {
      request,
      onDecide: async (reply) => {
        await this.options.chats.answerPermission(request.id, reply)
        this.finishPermission(request.id)
      },
      onFocus: () => this.setFocus("permission"),
      onLeave: () => this.setFocus("transcript"),
    })
    this.permissionPanel.setActive(this.focus === "permission")
    this.questionSlot.add(this.permissionPanel.root)
  }

  private removePermissionPanel(): void {
    const panel = this.permissionPanel
    if (!panel) return
    this.permissionPanel = null
    if (!this.questionSlot.isDestroyed && !panel.root.isDestroyed) this.questionSlot.remove(panel.root)
    panel.destroy()
  }

  /** What will answer what is being typed. */
  private composerMetaText(session: ChatSession | null): StyledText {
    const model = session?.model || this.defaultChoice?.modelId
    const reasoning = session?.model ? session.reasoning : this.defaultChoice?.reasoning
    const permission = permissionModeIcon(this.permissionMode(session))
    if (!model) return new StyledText([...permission, fg(QUEUED_COLOR)("no model · ^O chooses one")])
    const label = session?.parentSessionId
      ? new StyledText([
        fg(MODEL_COLOR)(session.agent ?? "worker"),
        fg(FAINT_COLOR)(" · "),
        ...permission,
        ...modelLabel(model, reasoning ?? null).chunks,
      ])
      : new StyledText([...permission, ...modelLabel(model, reasoning ?? null).chunks])
    if (!session) return label
    const monitorCount = this.armedMonitorCountBySession.get(session.id)
    if (monitorCount !== undefined && monitorCount > 0) {
      label.chunks.push(
        fg(FAINT_COLOR)(" · "),
        fg(MONITOR_COLOR)(`${monitorCount} monitor${monitorCount === 1 ? "" : "s"}`),
      )
    }
    const loopCount = this.activeLoopCountBySession.get(session.id)
    if (loopCount !== undefined && loopCount > 0) {
      label.chunks.push(
        fg(FAINT_COLOR)(" · "),
        fg(LOOP_COLOR)(`${loopCount} loop${loopCount === 1 ? "" : "s"}`),
      )
    }
    return label
  }

  private permissionMode(session: ChatSession | null): ChatPermissionMode {
    const rootSessionId = session?.parentSessionId ?? session?.id
    return rootSessionId ? (this.permissionModeByRootSession.get(rootSessionId) ?? "MANUAL") : "MANUAL"
  }

  private async refreshPermissionMode(sessionId: string): Promise<void> {
    try {
      this.acceptPermissionMode(await this.options.chats.permissionMode(sessionId))
    } catch (error) {
      this.options.logs.error("Chat permissions", error)
    }
  }

  private usageFits(meta: StyledText, hint: string, usage: StyledText): boolean {
    const usageWidth = styledTextWidth(usage)
    if (usageWidth === 0 || (this.options.embedded && hint.length > 0)) return false
    const widths = [styledTextWidth(meta), hint.length, usageWidth].filter((width) => width > 0)
    const required = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2
    const available = Math.max(0, this.root.width - (CHAT_INSET * 2 + 2))
    return required <= available
  }

  /**
   * Turns the spinner while a reply is coming, and only then.
   *
   * A timer that ran the whole time would repaint a screen nobody is waiting on, and
   * one that never ran would leave a thinking model looking like a hung one.
   */
  private syncSpinner(session: ChatSession | null): void {
    const running = session !== null && (
      this.streamingBySession.has(session.id) || this.compactingSessionId === session.id
    )
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
   * While a reply is running the list leads with the key that stops it. Interrupting
   * from a child transcript reaches the parent turn that owns that worker.
   */
  private hintText(session: ChatSession | null, availableWidth: number): string {
    if (this.connected === false) return CONNECT_HINT
    if (!this.selectedHasModel()) return NO_MODEL_HINT
    if (session?.parentSessionId) {
      const candidates = this.streamingBySession.has(session.id)
        ? [
            "Esc interrupt · Subagent running · ⌥←/→ workers · ⌥↑ parent",
            "Esc interrupt · ⌥←/→ workers · ⌥↑ parent",
            "Esc interrupt · ⌥↑ parent",
            "Esc interrupt",
          ]
        : [
            "Subagent transcript · ⌥←/→ workers · ⌥↑ parent",
            "⌥←/→ workers · ⌥↑ parent",
            "⌥↑ parent",
          ]
      return candidates.find((candidate) => candidate.length <= availableWidth) ?? ""
    }
    if (session && this.streamingBySession.has(session.id)) {
      return this.options.embedded ? "Esc interrupt" : RUNNING_HINT
    }
    return this.options.embedded ? "" : CHAT_HINT
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
    if (!session) return []
    if (!this.selectedHasModel()) {
      return [note("No model chosen for this chat.\n\nPress ^O to choose which model answers it.")]
    }

    const current = transcriptModelLabel(session.model || "model", session.reasoning)
    const blocks = (this.messagesBySession.get(session.id) ?? [])
      .map((message) => messageBlock(
        message,
        current,
        this.showThoughts,
        this.promptBackground(),
        this.options.embedded === true,
      ))
    const streaming = this.streamingBySession.get(session.id)
    if (streaming) {
      blocks.push(streamingBlock(streaming, current, {
        spinner: SPINNER_FRAMES[this.spinner] ?? SPINNER_FRAMES[0]!,
        elapsedMs: streaming.startedAt === null ? null : Date.now() - streaming.startedAt,
        showThoughts: this.showThoughts,
      }))
    }
    if (this.commandNotice) {
      const content = this.compactingSessionId === session.id
        ? `${SPINNER_FRAMES[this.spinner] ?? SPINNER_FRAMES[0]!} ${this.commandNotice}`
        : this.commandNotice
      blocks.push(note(content))
    }
    if (blocks.length === 0) return [note("Nothing said yet.")]
    return blocks
  }

  private promptBackground(): string {
    return this.marketOpen === false ? CLOSED_PROMPT_BG : PROMPT_BG
  }
}

function formatAutomations(state: ChatAutomationState, focus: "goal" | "loop"): string {
  if (focus === "goal") {
    const goal = state.goal
    if (!goal) return "No goal in this chat.\n\n/goal <objective>"
    const budget = goal.tokenBudget === null ? "no token budget" : `${goal.usedTokens}/${goal.tokenBudget} tokens`
    return [
      `${goal.status.toLowerCase()} goal`,
      goal.objective,
      `${goal.turnCount}/${goal.maxTurns} continuations · ${budget}`,
      ...(goal.lastEvaluation ? [`Evaluator: ${goal.lastEvaluation}`] : []),
      "",
      "Esc close · /goal pause · /goal resume · /goal clear",
    ].join("\n")
  }
  if (state.loops.length === 0) return "No scheduled tasks in this chat.\n\n/loop [interval] [task]"
  return [
    "Scheduled tasks",
    ...state.loops.map((loop) => (
      `${loop.id} · ${loop.status.toLowerCase()} · ${formatLoopSchedule(loop)} · next ${new Date(loop.nextRunAt).toLocaleString()} · ${loop.prompt}`
    )),
    "",
    "Esc close · /loop cancel <id>",
  ].join("\n")
}

function parseLoopCommand(argumentsText: string):
  | { action: "LIST" }
  | { action: "CANCEL"; loopId: string }
  | { action: "CREATE"; input: Parameters<ChatSessions["createLoop"]>[1] } {
  const text = argumentsText.trim()
  if (text.toLowerCase() === "list") return { action: "LIST" }
  if (/^cancel(?:\s|$)/iu.test(text)) {
    const [, loopId, extra] = text.split(/\s+/u)
    if (!loopId || extra) throw new Error("Usage: /loop cancel <id>")
    return { action: "CANCEL", loopId }
  }
  if (/^cron\s/iu.test(text)) {
    const words = text.slice(5).trim().split(/\s+/u)
    if (words.length < 5) throw new Error("Usage: /loop cron <5 fields> [task]")
    const cronExpression = words.slice(0, 5).join(" ")
    const prompt = words.slice(5).join(" ").trim()
    const promptOption = prompt ? { prompt } : {}
    return { action: "CREATE", input: { schedule: "CRON", cronExpression, ...promptOption } }
  }
  if (/^at\s/iu.test(text)) {
    const [, timestamp = "", ...promptWords] = text.split(/\s+/u)
    const runAt = Date.parse(timestamp)
    if (!Number.isFinite(runAt)) throw new Error("Usage: /loop at <ISO timestamp> [task]")
    const prompt = promptWords.join(" ").trim()
    const promptOption = prompt ? { prompt } : {}
    return { action: "CREATE", input: { schedule: "ONCE", runAt, ...promptOption } }
  }

  const [first = "", ...rest] = text.split(/\s+/u)
  const leadingInterval = parseLoopInterval(first)
  if (leadingInterval) {
    const prompt = rest.join(" ").trim()
    const promptOption = prompt ? { prompt } : {}
    return {
      action: "CREATE",
      input: { schedule: "INTERVAL", intervalMs: leadingInterval, ...promptOption },
    }
  }

  const trailing = text.match(/^(.*?)\s+every\s+(\d+)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)$/iu)
  if (trailing) {
    const prompt = trailing[1]?.trim() ?? ""
    const intervalMs = parseNaturalLoopInterval(trailing[2] ?? "", trailing[3] ?? "")
    if (!intervalMs) throw new Error("Loop interval must be at least one minute")
    const promptOption = prompt ? { prompt } : {}
    return {
      action: "CREATE",
      input: { schedule: "INTERVAL", intervalMs, ...promptOption },
    }
  }

  const promptOption = text ? { prompt: text } : {}
  return { action: "CREATE", input: { schedule: "DYNAMIC", ...promptOption } }
}

function parseNaturalLoopInterval(amount: string, unit: string): number | null {
  const normalized = unit.toLowerCase()
  const suffix = normalized.startsWith("s") ? "s" : normalized.startsWith("m") ? "m" : normalized.startsWith("h") ? "h" : "d"
  return parseLoopInterval(`${amount}${suffix}`)
}

function formatLoopSchedule(loop: ChatAutomationState["loops"][number]): string {
  if (loop.schedule === "CRON") return `cron ${loop.cronExpression}`
  if (loop.schedule === "ONCE") return `once ${new Date(loop.nextRunAt).toLocaleString()}`
  if (loop.schedule === "DYNAMIC") return `dynamic · next delay ${formatLoopInterval(loop.intervalMs ?? 60_000)}`
  return `every ${formatLoopInterval(loop.intervalMs ?? 60_000)}`
}

function formatLoopInterval(intervalMs: number): string {
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`
  return `${intervalMs / 60_000}m`
}

/**
 * A message as a turn in the transcript.
 *
 * A prompt uses a filled block in the full chat and a left rail in the trade panel.
 * Replies remain on the page with only a muted bullet.
 */
function messageBlock(
  message: ChatMessage,
  current: StyledText,
  showThoughts: boolean,
  promptBackground: string,
  embedded: boolean,
): ChatTranscriptBlock {
  if (message.role === "APP_EVENT") {
    return {
      id: message.id,
      marker: new StyledText([fg(COMPOSER_COLOR)("◆")]),
      header: new StyledText([fg(COMPOSER_COLOR)(message.toolName ?? "market monitor")]),
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
    const block: ChatTranscriptBlock = {
      id: message.id,
      padded: true,
      selectable: !queued,
      content: new StyledText([fg(queued ? QUEUED_COLOR : TEXT_COLOR)(message.text)]),
      ...(queued
        ? { footer: new StyledText([fg(QUEUED_COLOR)("queued · ^X cancels it")]) }
        : message.status === "FAILED"
          ? { footer: new StyledText([fg(ERROR_COLOR)("failed")]) }
          : {}),
    }
    if (embedded) block.rail = COMPOSER_COLOR
    else {
      block.marker = new StyledText([fg(queued ? QUEUED_COLOR : TURN_MARKER_COLOR)("›")])
      block.fill = promptBackground
    }
    return block
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
  const header = thought ? { header: thought } : {}
  return {
    id: message.id,
    marker: new StyledText([fg(TURN_MARKER_COLOR)("•")]),
    ...header,
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
  const header = thought ? { header: thought } : {}
  return {
    id: `streaming-${streaming.runId}`,
    marker: new StyledText([fg(TURN_MARKER_COLOR)("•")]),
    ...header,
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
  const label = message.model ? transcriptModelLabel(message.model, message.reasoning) : current
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
 * Visible by default, matching the live Codex transcript. `/thoughts` folds every thought when
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

function permissionModeIcon(mode: ChatPermissionMode): TextChunk[] {
  return mode === "AUTO"
    ? [fg(AUTO_PERMISSION_COLOR)("● ")]
    : [fg(MANUAL_PERMISSION_COLOR)("○ ")]
}

/** Model provenance recedes with the rest of a transcript footer. */
function transcriptModelLabel(model: string, reasoning: string | null): StyledText {
  const chunks: TextChunk[] = [fg(FAINT_COLOR)(model)]
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

function styledTextWidth(value: StyledText): number {
  return value.chunks.reduce((width, chunk) => width + chunk.text.length, 0)
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

function isShiftTab(key: KeyEvent): boolean {
  return key.name === "backtab" || (key.name === "tab" && key.shift)
}
