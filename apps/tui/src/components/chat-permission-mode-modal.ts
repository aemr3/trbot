import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import { CHAT_PERMISSION_MODES, type ChatPermissionMode } from "@trbot/chat/permission.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const MANUAL_COLOR = TUI_THEME.warning
const AUTO_COLOR = TUI_THEME.positive
const SELECTED_BG = TUI_THEME.overlaySelection

export interface ChatPermissionModeModalOptions {
  current: ChatPermissionMode
  onChoose: (mode: ChatPermissionMode) => Promise<void>
  onClose: () => void
}

/** Chooses whether sensitive tools stop for approval in this chat and its workers. */
export class ChatPermissionModeModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable
  private highlighted: ChatPermissionMode
  private busy = false
  private error: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatPermissionModeModalOptions,
  ) {
    this.highlighted = options.current
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
      width: 68,
      height: 12,
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
        this.highlighted = CHAT_PERMISSION_MODES[index] ?? "MANUAL"
        this.render()
      },
      onActivate: () => void this.choose(),
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      if (!this.busy) this.options.onClose()
      return true
    }
    if (this.busy) return true
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async choose(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.error = null
    this.render()
    try {
      await this.options.onChoose(this.highlighted)
    } catch (cause) {
      if (!this.destroyed) this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (!this.destroyed) {
        this.busy = false
        this.render()
      }
    }
  }

  private render(): void {
    if (this.destroyed) return
    this.header.content = new StyledText([
      fg(TEXT_COLOR)("Permissions\n"),
      fg(MUTED_COLOR)("Applies to this chat and its worker sessions.\n"),
    ])
    this.list.setRows([
      {
        id: "MANUAL",
        content: new StyledText([
          fg(MANUAL_COLOR)("○ "),
          fg(TEXT_COLOR)("Manual Mode"),
          fg(MUTED_COLOR)(" · Ask before sensitive actions"),
        ]),
      },
      {
        id: "AUTO",
        content: new StyledText([
          fg(AUTO_COLOR)("● "),
          fg(TEXT_COLOR)("Auto Mode"),
          fg(MUTED_COLOR)(" · Fully approve sensitive actions"),
        ]),
      },
    ], this.highlighted)
    this.footer.content = new StyledText([
      fg(this.error ? TUI_THEME.negative : MUTED_COLOR)(
        this.error
          ? `\n${this.error}`
          : this.busy
            ? "\nApplying…"
            : "\nEnter apply · ↑↓ mode · Esc close",
      ),
    ])
    this.renderer.requestRender()
  }

  private resizeModal(): void {
    this.modal.width = Math.max(44, Math.min(68, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(12, this.root.height - 2))
  }
}
