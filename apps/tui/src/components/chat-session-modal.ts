import { TUI_THEME } from "../theme.ts"
import {
  StyledText,
  fg,
  type BoxRenderable,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ChatSession } from "@trbot/chat/session.ts"
import { ListModalFrame } from "./list-modal-frame.ts"

const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const ACCENT_COLOR = TUI_THEME.accent
const MONITOR_COLOR = TUI_THEME.monitorAccent
const LOOP_COLOR = TUI_THEME.warning
const CONFIRM_COLOR = TUI_THEME.warning

export interface ChatSessionModalOptions {
  sessions: ChatSession[]
  monitorCounts?: ReadonlyMap<string, number>
  loopCounts?: ReadonlyMap<string, number>
  mobileConnections?: ReadonlyMap<string, boolean>
  /** The chat on screen behind the modal, marked so a trader knows where they are. */
  currentId: string | null
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onDelete: (sessionId: string) => void
  onClose: () => void
  /** Injected so a test does not depend on the day it runs on. */
  now?: () => number
}

/**
 * Picking a chat.
 *
 * A modal rather than a panel: a conversation wants the whole width, and the list of
 * conversations is something a trader wants for a moment and then not at all.
 */
export class ChatSessionModal {
  readonly root: BoxRenderable

  private readonly frame: ListModalFrame

  private sessions: ChatSession[]
  private currentId: string | null
  private monitorCounts: ReadonlyMap<string, number>
  private loopCounts: ReadonlyMap<string, number>
  private mobileConnections: ReadonlyMap<string, boolean>
  private highlighted: string | null = null
  private pendingDelete: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatSessionModalOptions,
  ) {
    this.sessions = order(options.sessions)
    this.currentId = options.currentId
    this.monitorCounts = options.monitorCounts ?? new Map()
    this.loopCounts = options.loopCounts ?? new Map()
    this.mobileConnections = options.mobileConnections ?? new Map()
    this.highlighted = options.currentId ?? this.sessions[0]?.id ?? null

    this.frame = new ListModalFrame(renderer, {
      maxWidth: 72,
      maxHeight: 22,
      minWidth: 40,
      minHeight: 10,
      wrapContent: true,
      onSelect: (index) => {
        this.highlighted = this.sessions[index]?.id ?? null
        // Moving off a chat withdraws the question, as it does on the trade screen: the
        // second d must mean the chat the trader is looking at.
        this.pendingDelete = null
        this.render()
      },
      onActivate: () => this.openHighlighted(),
    })
    this.root = this.frame.root
    this.render()
  }

  /** Keeps the list live: a reply can land, or a chat be renamed, while this is open. */
  setSessions(
    sessions: ChatSession[],
    currentId: string | null,
    monitorCounts: ReadonlyMap<string, number> = this.monitorCounts,
    loopCounts: ReadonlyMap<string, number> = this.loopCounts,
    mobileConnections: ReadonlyMap<string, boolean> = this.mobileConnections,
  ): void {
    if (this.destroyed) return
    this.sessions = order(sessions)
    this.currentId = currentId
    this.monitorCounts = monitorCounts
    this.loopCounts = loopCounts
    this.mobileConnections = mobileConnections
    if (!this.sessions.some((session) => session.id === this.highlighted)) {
      this.highlighted = currentId ?? this.sessions[0]?.id ?? null
    }
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (isLowercase(key, "n")) {
      this.options.onCreate()
      return true
    }
    if (isLowercase(key, "d")) {
      this.confirmDelete()
      return true
    }
    return this.frame.handleKey(key)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.frame.destroy()
  }

  private openHighlighted(): void {
    const sessionId = this.highlighted
    if (!sessionId) return
    this.options.onSelect(sessionId)
  }

  /**
   * Deleting takes two presses of d.
   *
   * A conversation cannot be recovered, and d sits beside the keys that move the
   * cursor.
   */
  private confirmDelete(): void {
    const sessionId = this.highlighted
    if (!sessionId) return
    if (this.pendingDelete === sessionId) {
      this.pendingDelete = null
      this.options.onDelete(sessionId)
      return
    }
    this.pendingDelete = sessionId
    this.render()
  }

  private render(): void {
    if (this.destroyed) return
    const now = this.options.now?.() ?? Date.now()
    this.frame.header.content = new StyledText([
      fg(VALUE_COLOR)("Sessions\n"),
      fg(MUTED_COLOR)(`${this.sessions.length === 1 ? "1 session" : `${this.sessions.length} sessions`}\n`),
    ])

    this.frame.list.setRows(
      this.sessions.map((session) => ({
        id: session.id,
        content: this.sessionRow(session, now),
      })),
      this.highlighted ?? undefined,
      { preserveScroll: true },
    )

    this.frame.footer.content = new StyledText(this.footerChunks())
    this.renderer.requestRender()
  }

  private sessionRow(session: ChatSession, now: number): StyledText {
    const current = session.id === this.currentId
    const title = `${this.mobileConnections.get(session.id) ? "📱 " : ""}${session.title}`
    const chunks: TextChunk[] = [
      fg(current ? ACCENT_COLOR : MUTED_COLOR)(current ? "• " : "  "),
      fg(VALUE_COLOR)(title),
    ]
    const marks: string[] = [formatWhen(session.updatedAt, now)]
    if (session.running) marks.push("answering")
    if (session.queued > 0) marks.push(`+${session.queued} queued`)
    chunks.push(fg(MUTED_COLOR)(`  ${marks.join(" · ")}`))
    const monitorCount = this.monitorCounts.get(session.id) ?? 0
    if (monitorCount > 0) {
      chunks.push(fg(MONITOR_COLOR)(` · ${monitorCount} monitor${monitorCount === 1 ? "" : "s"}`))
    }
    const loopCount = this.loopCounts.get(session.id) ?? 0
    if (loopCount > 0) {
      chunks.push(fg(LOOP_COLOR)(` · ${loopCount} loop${loopCount === 1 ? "" : "s"}`))
    }
    return new StyledText(chunks)
  }

  private footerChunks(): TextChunk[] {
    if (this.sessions.length === 0) {
      return [fg(MUTED_COLOR)("\nNo sessions yet.\nn starts one · Esc close")]
    }
    const pending = this.sessions.find((session) => session.id === this.pendingDelete)
    if (pending) {
      return [fg(CONFIRM_COLOR)(`\nPress d again to delete "${pending.title}".`)]
    }
    return [fg(MUTED_COLOR)("\nEnter open · n new · d delete · ↑↓ session · Esc close")]
  }
}

/** Most recently touched first: the chat a trader wants is nearly always the last one. */
function order(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
}

/** The time of day for something touched today, the date for anything older. */
function formatWhen(updatedAt: number, now: number): string {
  const when = new Date(updatedAt)
  const sameDay = new Date(now).toDateString() === when.toDateString()
  if (sameDay) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
  }
  return when.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
}

function isLowercase(key: KeyEvent, letter: string): boolean {
  if (key.ctrl || key.shift || key.meta || key.option) return false
  return key.name === letter && key.sequence !== letter.toUpperCase()
}
