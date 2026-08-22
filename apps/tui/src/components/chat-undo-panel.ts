import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  italic,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type { ChatMessage, ChatUndoPreview } from "@trbot/chat/session.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const ACCENT_COLOR = TUI_THEME.accent
const WARNING_COLOR = TUI_THEME.warning
const SELECTED_BG = TUI_THEME.overlaySelection
const CURRENT_ID = "__current__"
const CONVERSATION_ONLY_ID = "__conversation_only__"
const REVERSIBLE_ACTIONS_ID = "__reversible_actions__"
const MAX_PROMPT_LINES = 3
const LIST_RIGHT_PADDING = 2
const INDICATOR_WIDTH = 2
const PANEL_PADDING = 4
const PANEL_HORIZONTAL_CHROME = 10
const PANEL_BORDER_HEIGHT = 1
const MODAL_VERTICAL_CHROME = 4
const HEADER_HEIGHT = 4
const ROW_GAP = 1
const FOOTER_GAP = 1
const MAX_PANEL_HEIGHT = 16
const MODAL_WIDTH = 72

interface UndoRow {
  id: string
  message: ChatMessage | null
}

export interface ChatUndoPanelOptions {
  messages: ChatMessage[]
  presentation?: "inline" | "modal"
  backgroundColor?: string
  loadPreview: (message: ChatMessage) => Promise<ChatUndoPreview>
  onUndo: (message: ChatMessage, revertEffects: boolean) => void
  onError: (cause: unknown) => void
  onClose: () => void
}

type UndoStage = "PROMPTS" | "LOADING" | "CHOICE"

/** Prompt rewind picker, optionally presented as a modal for a clicked message. */
export class ChatUndoPanel {
  readonly root: BoxRenderable

  private readonly surface: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable
  private readonly rows: UndoRow[]
  private highlighted: string | null
  private stage: UndoStage = "PROMPTS"
  private selectedMessage: ChatMessage | null = null
  private preview: ChatUndoPreview | null = null
  private previewRequest = 0
  private committing = false
  private returnToPrompts = true
  private rendered = false
  private destroyed = false
  private promptWidth = 0
  private desiredHeight = 10
  private readonly backgroundColor: string

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatUndoPanelOptions,
  ) {
    this.backgroundColor = options.backgroundColor ?? PANEL_BG
    const messages = options.messages
      .filter((message) => message.role === "USER" && message.status !== "QUEUED")
    this.rows = [
      ...messages.map((message) => ({ id: message.id, message })),
      { id: CURRENT_ID, message: null },
    ]
    this.highlighted = CURRENT_ID

    if (options.presentation === "modal") {
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
      this.surface = new BoxRenderable(renderer, {
        width: MODAL_WIDTH,
        height: 10,
        flexDirection: "column",
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: this.backgroundColor,
        border: true,
        borderStyle: "rounded",
        borderColor: BORDER_COLOR,
        onSizeChange: () => this.syncPromptWidth(),
      })
      this.root.add(this.surface)
    } else {
      this.surface = new BoxRenderable(renderer, {
        width: "auto",
        height: Math.min(16, Math.max(10, this.rows.length + 7)),
        flexShrink: 0,
        flexDirection: "column",
        marginTop: 1,
        marginBottom: 1,
        marginLeft: 1,
        marginRight: 1,
        paddingTop: 0,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: this.backgroundColor,
        border: ["top"],
        borderStyle: "single",
        borderColor: ACCENT_COLOR,
        onSizeChange: () => this.syncPromptWidth(),
      })
      this.root = this.surface
    }
    this.header = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      height: HEADER_HEIGHT,
      flexShrink: 0,
      wrapMode: "word",
    })
    this.list = new SelectableList(renderer, {
      backgroundColor: this.backgroundColor,
      selectedBackgroundColor: options.presentation === "modal" ? SELECTED_BG : this.backgroundColor,
      indicatorColor: ACCENT_COLOR,
      selectedIndicator: "› ",
      wrapContent: true,
      rowGap: ROW_GAP,
      startAtBottom: true,
      onSelect: (index) => {
        this.highlighted = this.stage === "PROMPTS"
          ? this.rows[index]?.id ?? null
          : this.choiceRows()[index]?.id ?? null
        this.render()
      },
      onActivate: () => this.activateHighlighted(),
    })
    // This picker scrolls only vertically. Reclaim OpenTUI's hidden horizontal
    // scrollbar row so the footer separation is an explicit, stable gap.
    this.list.root.horizontalScrollBar.height = 0
    this.footer = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexShrink: 0,
      marginTop: FOOTER_GAP,
      wrapMode: "word",
    })
    this.surface.add(this.header)
    this.surface.add(this.list.root)
    this.surface.add(this.footer)
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      if (this.stage !== "PROMPTS" && this.returnToPrompts) this.showPrompts()
      else this.options.onClose()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.activateHighlighted()
      return true
    }
    if (!this.committing && this.stage !== "LOADING") this.list.handleKey(key)
    return true
  }

  /** Opens the confirmation choices for a prompt selected in the transcript. */
  openMessage(message: ChatMessage): boolean {
    if (this.destroyed || this.committing || this.stage === "LOADING") return false
    const row = this.rows.find((candidate) => candidate.message?.id === message.id)
    if (!row?.message) return false
    this.returnToPrompts = false
    this.highlighted = row.id
    this.loadMessage(row.message)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.previewRequest += 1
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private activateHighlighted(): void {
    if (this.committing) return
    if (this.stage === "LOADING") return
    if (this.stage === "CHOICE") {
      const message = this.selectedMessage
      if (!message) return
      const revertEffects = this.highlighted === REVERSIBLE_ACTIONS_ID
      this.committing = true
      this.render()
      this.options.onUndo(message, revertEffects)
      return
    }
    const row = this.rows.find((candidate) => candidate.id === this.highlighted)
    if (!row) return
    if (!row.message) {
      this.options.onClose()
      return
    }
    this.returnToPrompts = true
    this.loadMessage(row.message)
  }

  private loadMessage(message: ChatMessage): void {
    this.selectedMessage = message
    this.stage = "LOADING"
    const request = ++this.previewRequest
    this.render()
    void this.options.loadPreview(message).then((preview) => {
      if (this.destroyed || request !== this.previewRequest) return
      this.preview = preview
      this.stage = "CHOICE"
      this.highlighted = CONVERSATION_ONLY_ID
      this.rendered = false
      this.render()
    }).catch((cause: unknown) => {
      if (this.destroyed || request !== this.previewRequest) return
      this.options.onError(cause)
      if (this.returnToPrompts) this.showPrompts()
      else this.options.onClose()
    })
  }

  private render(): void {
    if (this.destroyed) return
    const modal = this.options.presentation === "modal"
    const directLoading = modal && this.stage === "LOADING" && !this.returnToPrompts
    this.header.content = new StyledText([
      fg(ACCENT_COLOR)(`${modal ? "Message actions" : "Rewind"}\n\n`),
      fg(VALUE_COLOR)(this.stage === "CHOICE" || directLoading
        ? "Undo this message?"
        : "Restore the conversation to the point before…"),
    ])
    const displayRows = this.stage === "CHOICE"
      ? this.choiceDisplayRows()
      : directLoading
        ? []
        : this.promptDisplayRows()
    const listHeight = displayRows.reduce((total, row) => total + row.lineCount, 0)
      + Math.max(0, displayRows.length - 1) * ROW_GAP
    const footerHeight = 1
    this.desiredHeight = Math.min(
      MAX_PANEL_HEIGHT,
      Math.max(
        10,
        (modal ? MODAL_VERTICAL_CHROME : PANEL_BORDER_HEIGHT)
          + HEADER_HEIGHT
          + listHeight
          + FOOTER_GAP
          + footerHeight,
      ),
    )
    this.surface.height = this.desiredHeight
    if (modal) this.resizeModal()
    this.list.setRows(displayRows, this.highlighted ?? undefined, { preserveScroll: this.rendered })
    this.rendered = true

    this.footer.content = new StyledText([
      this.stage === "LOADING"
        ? italic(fg(MUTED_COLOR)(`Checking tool actions…${directLoading ? " · Esc to cancel" : ""}`))
        : this.stage === "CHOICE"
          ? italic(fg(this.committing ? MUTED_COLOR : WARNING_COLOR)(
              this.committing
                ? "Rewinding…"
                : `Enter to confirm · Esc to ${this.returnToPrompts ? "go back" : "cancel"}`,
            ))
          : italic(fg(MUTED_COLOR)("Enter to continue · Esc to cancel")),
    ])
    this.renderer.requestRender()
  }

  private promptDisplayRows() {
    return this.rows.map((row) => {
      const selected = row.id === this.highlighted
      const text = row.message
        ? clampPrompt(row.message.text, this.resolvedPromptWidth(), MAX_PROMPT_LINES)
        : "(current)"
      return {
        id: row.id,
        lineCount: text.split("\n").length,
        content: new StyledText([
          selected ? italic(fg(ACCENT_COLOR)(text)) : fg(VALUE_COLOR)(text),
        ]),
      }
    })
  }

  private choiceRows(): Array<{ id: string; text: string }> {
    const effects = this.preview?.effects ?? []
    const reversible = effects.filter((effect) => effect.reversible)
    const preserved = effects.filter((effect) => !effect.reversible)
    const width = Math.max(1, this.resolvedPromptWidth() - 2)
    const actionLines = [
      ...reversible.map((effect) => `  Undo: ${clampPrompt(effect.description, width, 1)}`),
      ...preserved.map((effect) => `  Keep: ${clampPrompt(effect.description, width, 1)}`),
    ]
    return [
      {
        id: CONVERSATION_ONLY_ID,
        text: `Conversation only\n  Keep all ${effects.length} recorded action${effects.length === 1 ? "" : "s"}`,
      },
      {
        id: REVERSIBLE_ACTIONS_ID,
        text: [
          "Conversation + reversible actions",
          ...(actionLines.length > 0 ? actionLines : ["  No recorded actions to restore"]),
        ].join("\n"),
      },
    ]
  }

  private choiceDisplayRows() {
    return this.choiceRows().map((row) => ({
      id: row.id,
      lineCount: row.text.split("\n").length,
      content: new StyledText([
        row.id === this.highlighted
          ? italic(fg(ACCENT_COLOR)(row.text))
          : fg(VALUE_COLOR)(row.text),
      ]),
    }))
  }

  private showPrompts(): void {
    this.previewRequest += 1
    this.stage = "PROMPTS"
    this.selectedMessage = null
    this.preview = null
    this.highlighted = CURRENT_ID
    this.committing = false
    this.returnToPrompts = true
    this.rendered = false
    this.render()
  }

  private resolvedPromptWidth(): number {
    if (this.promptWidth > 0) return this.promptWidth
    return Math.max(1, this.renderer.width - PANEL_HORIZONTAL_CHROME)
  }

  private syncPromptWidth(): void {
    const listWidth = this.surface.width - PANEL_PADDING
    if (listWidth <= LIST_RIGHT_PADDING + INDICATOR_WIDTH) return
    const width = listWidth - LIST_RIGHT_PADDING - INDICATOR_WIDTH
    if (width === this.promptWidth) return
    this.promptWidth = width
    this.rendered = false
    this.render()
  }

  private resizeModal(): void {
    if (this.options.presentation !== "modal") return
    if (this.root.width > 4) this.surface.width = Math.min(MODAL_WIDTH, this.root.width - 4)
    if (this.root.height > 2) this.surface.height = Math.min(this.desiredHeight, this.root.height - 2)
  }
}

function clampPrompt(prompt: string, width: number, maxLines: number): string {
  let remaining = graphemes(prompt.replace(/\s+/gu, " ").trim())
  const lines: string[] = []

  while (remaining.length > 0 && lines.length < maxLines) {
    while (remaining[0] === " ") remaining.shift()
    let cells = 0
    let end = 0
    let lastSpace = -1

    while (end < remaining.length) {
      const nextWidth = Bun.stringWidth(remaining[end]!)
      if (end > 0 && cells + nextWidth > width) break
      cells += nextWidth
      if (remaining[end] === " ") lastSpace = end
      end += 1
    }

    if (end === remaining.length) {
      lines.push(remaining.join("").trimEnd())
      remaining = []
      break
    }

    const breakAt = lastSpace > 0 ? lastSpace : Math.max(1, end)
    lines.push(remaining.slice(0, breakAt).join("").trimEnd())
    remaining = remaining.slice(lastSpace > 0 ? lastSpace + 1 : breakAt)
  }

  if (remaining.length > 0) {
    const suffix = "..."
    const lastIndex = lines.length - 1
    let last = graphemes(lines[lastIndex] ?? "")
    while (last.length > 0 && Bun.stringWidth(`${last.join("")}${suffix}`) > width) last.pop()
    lines[lastIndex] = `${last.join("").trimEnd()}${suffix}`
  }

  return lines.join("\n")
}

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .map((part) => part.segment)
}
