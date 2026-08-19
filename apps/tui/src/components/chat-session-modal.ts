import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ChatSession } from "@trbot/chat/session.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const ACCENT_COLOR = "#7c83ff"
const CONFIRM_COLOR = "#e5c07b"
const SELECTED_BG = "#22252d"

export interface ChatSessionModalOptions {
  sessions: ChatSession[]
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

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable

  private sessions: ChatSession[]
  private currentId: string | null
  private highlighted: string | null = null
  private pendingDelete: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatSessionModalOptions,
  ) {
    this.sessions = order(options.sessions)
    this.currentId = options.currentId
    this.highlighted = options.currentId ?? this.sessions[0]?.id ?? null

    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      onSizeChange: () => this.resizeModal(),
    })
    this.modal = new BoxRenderable(renderer, {
      width: 72,
      height: 22,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: BORDER_COLOR,
      flexDirection: "column",
    })
    this.header = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      onSelect: (index) => {
        this.highlighted = this.sessions[index]?.id ?? null
        // Moving off a chat withdraws the question, as it does on the trade screen: the
        // second d must mean the chat the trader is looking at.
        this.pendingDelete = null
        this.render()
      },
      onActivate: () => this.openHighlighted(),
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  /** Keeps the list live: a reply can land, or a chat be renamed, while this is open. */
  setSessions(sessions: ChatSession[], currentId: string | null): void {
    if (this.destroyed) return
    this.sessions = order(sessions)
    this.currentId = currentId
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
    if (key.name === "return" || key.name === "enter") {
      this.openHighlighted()
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
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
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
    this.header.content = new StyledText([
      fg(VALUE_COLOR)("Chats\n"),
      fg(MUTED_COLOR)(`${this.sessions.length === 1 ? "1 chat" : `${this.sessions.length} chats`}\n`),
    ])

    this.list.setRows(
      this.sessions.map((session) => ({
        id: session.id,
        content: this.sessionRow(session, now),
      })),
      this.highlighted ?? undefined,
      { preserveScroll: true },
    )

    this.footer.content = new StyledText(this.footerChunks())
    this.renderer.requestRender()
  }

  private sessionRow(session: ChatSession, now: number): StyledText {
    const current = session.id === this.currentId
    const chunks: TextChunk[] = [
      fg(current ? ACCENT_COLOR : MUTED_COLOR)(current ? "• " : "  "),
      fg(VALUE_COLOR)(session.title),
    ]
    const marks: string[] = [formatWhen(session.updatedAt, now)]
    if (session.running) marks.push("answering")
    if (session.queued > 0) marks.push(`+${session.queued} queued`)
    chunks.push(fg(MUTED_COLOR)(`  ${marks.join(" · ")}`))
    return new StyledText(chunks)
  }

  private footerChunks(): TextChunk[] {
    if (this.sessions.length === 0) {
      return [fg(MUTED_COLOR)("\nNo chats yet.\nn starts one · Esc close")]
    }
    const pending = this.sessions.find((session) => session.id === this.pendingDelete)
    if (pending) {
      return [fg(CONFIRM_COLOR)(`\nPress d again to delete "${pending.title}".`)]
    }
    return [fg(MUTED_COLOR)("\nEnter open · n new · d delete · ↑↓ chat · Esc close")]
  }

  private resizeModal(): void {
    this.modal.width = Math.max(40, Math.min(72, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(22, this.root.height - 2))
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
