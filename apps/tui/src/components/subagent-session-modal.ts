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
const RUNNING_COLOR = TUI_THEME.running

export interface SubagentSessionModalOptions {
  sessions: ChatSession[]
  currentId: string | null
  onSelect: (sessionId: string) => void
  onClose: () => void
  now?: () => number
}

/** Read-only picker for the durable worker transcripts beneath one conversation. */
export class SubagentSessionModal {
  readonly root: BoxRenderable

  private readonly frame: ListModalFrame
  private sessions: ChatSession[]
  private currentId: string | null
  private highlighted: string | null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: SubagentSessionModalOptions,
  ) {
    this.sessions = order(options.sessions)
    this.currentId = options.currentId
    this.highlighted = this.sessions.some((session) => session.id === options.currentId)
      ? options.currentId
      : (this.sessions[0]?.id ?? null)

    this.frame = new ListModalFrame(renderer, {
      maxWidth: 76,
      maxHeight: 22,
      minWidth: 42,
      minHeight: 10,
      wrapContent: true,
      onSelect: (index) => {
        this.highlighted = this.sessions[index]?.id ?? null
        this.render()
      },
      onActivate: () => this.openHighlighted(),
    })
    this.root = this.frame.root
    this.render()
  }

  setSessions(sessions: ChatSession[], currentId: string | null): void {
    if (this.destroyed) return
    this.sessions = order(sessions)
    this.currentId = currentId
    if (!this.sessions.some((session) => session.id === this.highlighted)) {
      this.highlighted = this.sessions[0]?.id ?? null
    }
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
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
    if (this.highlighted) this.options.onSelect(this.highlighted)
  }

  private render(): void {
    if (this.destroyed) return
    const now = this.options.now?.() ?? Date.now()
    this.frame.header.content = new StyledText([
      fg(VALUE_COLOR)("Subagents\n"),
      fg(MUTED_COLOR)(`${this.sessions.length} worker session${this.sessions.length === 1 ? "" : "s"}\n`),
    ])
    this.frame.list.setRows(
      this.sessions.map((session) => ({ id: session.id, content: this.sessionRow(session, now) })),
      this.highlighted ?? undefined,
      { preserveScroll: true },
    )
    this.frame.footer.content = new StyledText([
      fg(MUTED_COLOR)(this.sessions.length === 0
        ? "\nNo subagents have run in this session.\nEsc close"
        : "\nEnter open transcript · ↑↓ worker · Esc close"),
    ])
    this.renderer.requestRender()
  }

  private sessionRow(session: ChatSession, now: number): StyledText {
    const current = session.id === this.currentId
    const chunks: TextChunk[] = [
      fg(current ? ACCENT_COLOR : MUTED_COLOR)(current ? "• " : "  "),
      fg(session.running ? RUNNING_COLOR : MUTED_COLOR)(session.running ? "● " : "✓ "),
      fg(MUTED_COLOR)(`${formatWhen(session.updatedAt, now)} `),
      fg(VALUE_COLOR)(session.title),
    ]
    return new StyledText(chunks)
  }
}

function order(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => right.createdAt - left.createdAt)
}

function formatWhen(updatedAt: number, now: number): string {
  const when = new Date(updatedAt)
  if (new Date(now).toDateString() === when.toDateString()) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
  }
  return when.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
}
