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
const RUNNING_COLOR = "#d7c58a"
const SELECTED_BG = "#22252d"

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

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable
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
      width: 76,
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
    if (key.name === "return" || key.name === "enter") {
      this.openHighlighted()
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
    if (this.highlighted) this.options.onSelect(this.highlighted)
  }

  private render(): void {
    if (this.destroyed) return
    const now = this.options.now?.() ?? Date.now()
    this.header.content = new StyledText([
      fg(VALUE_COLOR)("Subagents\n"),
      fg(MUTED_COLOR)(`${this.sessions.length} worker session${this.sessions.length === 1 ? "" : "s"}\n`),
    ])
    this.list.setRows(
      this.sessions.map((session) => ({ id: session.id, content: this.sessionRow(session, now) })),
      this.highlighted ?? undefined,
      { preserveScroll: true },
    )
    this.footer.content = new StyledText([
      fg(MUTED_COLOR)(this.sessions.length === 0
        ? "\nNo subagents have run in this session.\nEsc close"
        : "\nEnter open transcript · ↑↓ worker · Esc close"),
    ])
    this.renderer.requestRender()
  }

  private sessionRow(session: ChatSession, now: number): StyledText {
    const current = session.id === this.currentId
    const status = session.running ? "running" : "done"
    const chunks: TextChunk[] = [
      fg(current ? ACCENT_COLOR : MUTED_COLOR)(current ? "• " : "  "),
      fg(VALUE_COLOR)(session.title),
      fg(MUTED_COLOR)(`  ${session.agent ?? "worker"} · ${formatWhen(session.updatedAt, now)} · `),
      fg(session.running ? RUNNING_COLOR : MUTED_COLOR)(status),
    ]
    return new StyledText(chunks)
  }

  private resizeModal(): void {
    this.modal.width = Math.max(42, Math.min(76, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(22, this.root.height - 2))
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
