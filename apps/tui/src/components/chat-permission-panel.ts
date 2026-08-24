import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type { ChatPermissionReply, ChatPermissionRequest } from "@trbot/chat/permission.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.questionBackground
const BORDER_COLOR = TUI_THEME.questionBorder
const ACTIVE_BORDER_COLOR = TUI_THEME.activeBorder
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const ACCENT_COLOR = TUI_THEME.warning
const ERROR_COLOR = TUI_THEME.negative
const SELECTED_BG = TUI_THEME.questionSelection

export interface ChatPermissionPanelOptions {
  request: ChatPermissionRequest
  onDecide: (reply: ChatPermissionReply) => Promise<void>
  onFocus: () => void
  onLeave: () => void
}

/** Holds a sensitive tool call beside the composer until the user decides. */
export class ChatPermissionPanel {
  readonly root: BoxRenderable
  readonly requestId: string

  private readonly content: TextRenderable
  private readonly list: SelectableList
  private readonly denialInput: TextRenderable
  private readonly footer: TextRenderable
  private active = true
  private enteringDenialReason = false
  private typedReason = ""
  private busy = false
  private error: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatPermissionPanelOptions,
  ) {
    this.requestId = options.request.id
    this.root = new BoxRenderable(renderer, {
      width: "auto",
      height: (options.request.reason ? 11 : 9) + (options.request.scope === "SESSION" ? 1 : 0),
      flexShrink: 0,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: ACTIVE_BORDER_COLOR,
      flexDirection: "column",
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        this.options.onFocus()
      },
    })
    this.content = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      height: options.request.reason ? 3 : 2,
      flexShrink: 0,
      wrapMode: "word",
    })
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      wrapContent: true,
      onFocusRequest: options.onFocus,
      onActivate: (index) => this.choose(index),
    })
    this.denialInput = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", flexShrink: 0 })
    this.root.add(this.content)
    this.root.add(this.list.root)
    this.root.add(this.denialInput)
    this.root.add(this.footer)
    this.render()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.root.borderColor = active ? ACTIVE_BORDER_COLOR : BORDER_COLOR
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.busy) return true
    if (this.enteringDenialReason) return this.handleDenialReasonKey(key)
    if (key.name === "tab" || key.name === "backtab" || key.name === "escape" || key.name === "esc") {
      this.options.onLeave()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.choose(this.list.selectedIndex)
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

  private choose(index: number): void {
    const request = this.options.request
    if (index === 0) {
      void this.decide({ decision: "ALLOW", scope: "ONCE" })
      return
    }
    if (request.scope === "SESSION" && index === 1) {
      void this.decide({ decision: "ALLOW", scope: "SESSION" })
      return
    }
    this.enteringDenialReason = true
    this.typedReason = ""
    this.render()
  }

  private handleDenialReasonKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.enteringDenialReason = false
      this.typedReason = ""
      this.render()
      return true
    }
    if (key.name === "tab" || key.name === "backtab") {
      this.options.onLeave()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      const reason = this.typedReason.trim()
      void this.decide(reason ? { decision: "DENY", reason } : { decision: "DENY" })
      return true
    }
    if (key.name === "backspace") {
      this.typedReason = [...this.typedReason].slice(0, -1).join("")
      this.render()
      return true
    }
    if (key.ctrl || key.meta || key.option || !isPrintable(key.sequence)) return true
    if (this.typedReason.length < 1_000) this.typedReason += key.sequence
    this.render()
    return true
  }

  private async decide(reply: ChatPermissionReply): Promise<void> {
    this.busy = true
    this.error = null
    this.render()
    try {
      await this.options.onDecide(reply)
    } catch (error) {
      if (this.destroyed) return
      this.busy = false
      this.error = error instanceof Error ? error.message : String(error)
      this.render()
    }
  }

  private render(): void {
    if (this.destroyed) return
    const request = this.options.request
    this.content.content = new StyledText([
      fg(ACCENT_COLOR)(`Permission required · ${request.toolName}`),
      fg(TEXT_COLOR)(`\n${request.action}`),
      ...(request.reason
        ? [fg(MUTED_COLOR)(`\nReason: ${request.reason}`)]
        : []),
    ])
    this.list.root.visible = !this.enteringDenialReason
    this.denialInput.visible = this.enteringDenialReason
    this.denialInput.content = new StyledText([
      fg(ACCENT_COLOR)("> "),
      fg(this.typedReason ? TEXT_COLOR : MUTED_COLOR)(this.typedReason || "Why deny? (optional)"),
    ])
    this.list.setRows([
      {
        id: "allow-once",
        content: new StyledText([
          fg(TEXT_COLOR)("Allow once"),
          fg(MUTED_COLOR)("  approve only this call"),
        ]),
      },
      ...(request.scope === "SESSION" ? [{
        id: "allow-session",
        content: new StyledText([
          fg(TEXT_COLOR)("Allow for this session"),
          fg(MUTED_COLOR)("  remember this tool in this session"),
        ]),
      }] : []),
      {
        id: "deny",
        content: new StyledText([
          fg(TEXT_COLOR)("Deny"),
          fg(MUTED_COLOR)("  do not execute this action"),
        ]),
      },
    ], this.list.selectedIndex === -1 ? "allow-once" : undefined)
    this.footer.content = new StyledText([
      fg(this.error ? ERROR_COLOR : MUTED_COLOR)(
        this.error ?? (
          this.busy
            ? "Saving decision…"
            : !this.active
              ? "Tab to decide"
              : this.enteringDenialReason
                ? "Enter deny · Esc choices · reason optional"
                : "Enter choose · Tab review chat"
        ),
      ),
    ])
    this.renderer.requestRender()
  }
}

function isPrintable(sequence: string): boolean {
  return [...sequence].length === 1 && sequence >= " " && sequence !== "\x7f"
}
