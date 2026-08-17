import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  link,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ChatGptAccount } from "@trbot/ai/chatgpt-account.ts"
import type { ProviderState } from "@trbot/ai/provider-state.ts"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c83ff"
const SUCCESS_COLOR = "#70d7a1"
const ERROR_COLOR = "#ff6b6b"

type ModalStatus = "loading" | "disconnected" | "connecting" | "connected" | "disconnecting" | "error"

export interface ProviderAccountModalOptions {
  account: ChatGptAccount
  onClose: () => void
}

export class ProviderAccountModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private state: ProviderState | null = null
  private status: ModalStatus = "loading"
  private message: string | null = null
  private authorizationUrl: string | null = null
  private request: AbortController | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ProviderAccountModalOptions,
  ) {
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
      height: 19,
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
    this.content = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
    })
    this.modal.add(this.content)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    void this.load()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (this.status === "loading" || this.status === "connecting" || this.status === "disconnecting") return true
    if (!key.ctrl && !key.meta && !key.option && key.name === "d" && this.state) {
      void this.disconnect()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      void this.connect()
      return true
    }
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.request?.abort()
    this.request = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async load(): Promise<void> {
    try {
      this.state = await this.options.account.getState()
      if (this.destroyed) return
      this.status = this.state ? "connected" : "disconnected"
      this.render()
    } catch (error) {
      if (this.destroyed) return
      this.fail(error)
    }
  }

  private async connect(): Promise<void> {
    if (this.request || this.destroyed) return
    const request = new AbortController()
    this.request = request
    this.status = "connecting"
    this.message = "Waiting for browser authorization…"
    this.authorizationUrl = null
    this.render()

    try {
      const state = await this.options.account.connect({
        signal: request.signal,
        onAuthorizationUrl: (url) => {
          if (this.destroyed || request.signal.aborted) return
          this.authorizationUrl = url
          this.render()
        },
        onBrowserError: () => {
          if (this.destroyed || request.signal.aborted) return
          this.message = "Could not open the browser. Open the link below."
          this.render()
        },
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.state = state
      this.status = "connected"
      this.message = "ChatGPT connected."
      this.authorizationUrl = null
      this.render()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) return
      this.fail(error)
    } finally {
      if (this.request === request) this.request = null
    }
  }

  private async disconnect(): Promise<void> {
    if (this.request || this.destroyed) return
    this.status = "disconnecting"
    this.message = "Disconnecting…"
    this.render()
    try {
      await this.options.account.disconnect()
      if (this.destroyed) return
      this.state = null
      this.status = "disconnected"
      this.message = "ChatGPT disconnected."
      this.render()
    } catch (error) {
      if (this.destroyed) return
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    this.status = "error"
    this.message = errorMessage(error)
    this.render()
  }

  private render(): void {
    const chunks: TextChunk[] = [
      fg(VALUE_COLOR)("AI provider\n\n"),
      ...row("Provider", "ChatGPT"),
      ...row("Status", statusLabel(this.status), statusColor(this.status)),
    ]
    if (this.state?.email) chunks.push(...row("Account", this.state.email))
    else if (this.state?.accountId) chunks.push(...row("Account", this.state.accountId))
    if (this.message) chunks.push(fg(VALUE_COLOR)("\n"), fg(this.status === "error" ? ERROR_COLOR : MUTED_COLOR)(this.message))
    if (this.authorizationUrl) {
      chunks.push(
        fg(VALUE_COLOR)("\n\n"),
        fg(EMPHASIS_COLOR)(link(this.authorizationUrl)(this.authorizationUrl)),
      )
    }
    chunks.push(
      fg(VALUE_COLOR)("\n\n"),
      fg(MUTED_COLOR)(this.state
        ? "Enter reconnect · d disconnect · Esc close"
        : "Enter connect in browser · Esc close"),
    )
    this.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }

  private resizeModal(): void {
    if (this.root.width <= 0 || this.root.height <= 0) return
    this.modal.width = Math.max(1, Math.min(76, this.root.width - 2))
    this.modal.height = Math.max(1, Math.min(19, this.root.height - 2))
  }
}

function row(label: string, value: string, color = VALUE_COLOR): TextChunk[] {
  return [fg(MUTED_COLOR)(`${label.padEnd(14)} `), fg(color)(value), fg(VALUE_COLOR)("\n")]
}

function statusLabel(status: ModalStatus): string {
  if (status === "loading") return "Loading…"
  if (status === "connecting") return "Connecting…"
  if (status === "disconnecting") return "Disconnecting…"
  if (status === "connected") return "Connected"
  if (status === "disconnected") return "Not connected"
  return "Error"
}

function statusColor(status: ModalStatus): string {
  if (status === "connected") return SUCCESS_COLOR
  if (status === "error") return ERROR_COLOR
  if (status === "connecting" || status === "disconnecting") return EMPHASIS_COLOR
  return MUTED_COLOR
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
