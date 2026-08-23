import { BoxRenderable, StyledText, TextRenderable, fg, link, type KeyEvent, type RenderContext } from "@opentui/core"
import { ErrorCorrectionLevel, QRCodeRenderable } from "@opentui/qrcode"
import type { ChatMobileConnection, ChatMobilePairing, ChatMobileState } from "@trbot/chat/mobile.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { TUI_THEME } from "../theme.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const ACCENT_COLOR = TUI_THEME.accent
const ERROR_COLOR = TUI_THEME.negative
const POLL_MS = 1_000

export interface ChatMobileModalOptions {
  chats: Pick<ChatSessions, "mobile" | "connectMobile">
  sessionId: string
  onConnected: (connection: ChatMobileConnection) => void
  onClose: () => void
}

/** Pairs the selected server-owned chat to Telegram without exposing a server credential. */
export class ChatMobileModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly qrSlot: BoxRenderable
  private readonly footer: TextRenderable
  private qr: QRCodeRenderable | null = null
  private state: ChatMobileState | null = null
  private pairing: ChatMobilePairing | null = null
  private error: string | null = null
  private busy = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatMobileModalOptions,
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
      width: 64,
      height: 34,
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
    this.qrSlot = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: PANEL_BG,
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.qrSlot)
    this.modal.add(this.footer)
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
    if (this.busy) return true
    if (!key.ctrl && !key.meta && !key.option && key.name.toLowerCase() === "r") {
      void this.load(true)
      return true
    }
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopPolling()
    this.removeQr()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async load(forcePairing = false): Promise<void> {
    if (this.destroyed || this.busy) return
    this.busy = true
    this.error = null
    if (forcePairing) this.pairing = null
    this.render()
    try {
      this.state = await this.options.chats.mobile(this.options.sessionId)
      if (this.destroyed) return
      if (!this.state.available) {
        this.pairing = null
        this.stopPolling()
        this.render()
        return
      }
      if (this.state.connection) {
        this.finish(this.state.connection)
        return
      }
      this.pairing = await this.options.chats.connectMobile(this.options.sessionId)
      if (this.destroyed) return
      this.startPolling()
    } catch (cause) {
      if (this.destroyed) return
      this.error = errorMessage(cause)
      this.stopPolling()
    } finally {
      this.busy = false
      this.render()
      if (this.pairing) void this.refreshState()
    }
  }

  private async refreshState(): Promise<void> {
    if (this.destroyed || this.busy || !this.pairing) return
    if (this.pairing.expiresAt <= Date.now()) {
      this.stopPolling()
      this.render()
      return
    }
    try {
      const state = await this.options.chats.mobile(this.options.sessionId)
      if (this.destroyed) return
      this.state = state
      if (state.connection) {
        this.finish(state.connection)
      }
    } catch (cause) {
      if (!this.destroyed) this.error = errorMessage(cause)
    }
  }

  private finish(connection: ChatMobileConnection): void {
    this.pairing = null
    this.stopPolling()
    this.options.onConnected(connection)
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => void this.refreshState(), POLL_MS)
  }

  private stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private render(): void {
    if (this.destroyed) return
    this.removeQr()

    if (this.error) {
      this.header.content = new StyledText([
        fg(TEXT_COLOR)("Connect phone"),
        fg(ERROR_COLOR)(`\n\n${this.error}`),
      ])
      this.footer.content = new StyledText([fg(MUTED_COLOR)("R retry · Esc close")])
      this.renderer.requestRender()
      return
    }

    if (this.busy && !this.state) {
      this.header.content = new StyledText([fg(TEXT_COLOR)("Connect phone"), fg(MUTED_COLOR)("\n\nPreparing Telegram…")])
      this.footer.content = new StyledText([fg(MUTED_COLOR)("Esc close")])
      this.renderer.requestRender()
      return
    }

    if (this.state && !this.state.available) {
      this.header.content = new StyledText([
        fg(TEXT_COLOR)("Connect phone"),
        fg(MUTED_COLOR)("\n\nTelegram is not configured on the server."),
        fg(TEXT_COLOR)("\nSet TRBOT_TELEGRAM_BOT_TOKEN and restart the server."),
      ])
      this.footer.content = new StyledText([fg(MUTED_COLOR)("R retry · Esc close")])
      this.renderer.requestRender()
      return
    }

    if (this.pairing) {
      const expired = this.pairing.expiresAt <= Date.now()
      this.header.content = new StyledText([
        fg(TEXT_COLOR)("Connect phone"),
        fg(MUTED_COLOR)(expired
          ? "\n\nThis QR code expired."
          : "\n\nScan with your phone, open Telegram, then press Start."),
      ])
      if (!expired) {
        this.qr = new QRCodeRenderable(this.renderer, {
          content: this.pairing.url,
          errorCorrectionLevel: ErrorCorrectionLevel.M,
          quietZone: 4,
          scale: 1,
          fit: "contain",
          foregroundColor: "#000000",
          backgroundColor: "#ffffff",
          fallbackContent: "Resize the terminal to show the QR code",
          fallbackColor: MUTED_COLOR,
        })
        this.qrSlot.add(this.qr)
      }
      this.footer.content = expired
        ? new StyledText([fg(ACCENT_COLOR)("R"), fg(MUTED_COLOR)(" new code · Esc close")])
        : new StyledText([
          fg(MUTED_COLOR)("Or open "),
          fg(ACCENT_COLOR)(link(this.pairing.url)(this.pairing.url)),
          fg(MUTED_COLOR)("\nR new code · Esc close"),
        ])
      this.renderer.requestRender()
      return
    }

    this.header.content = new StyledText([fg(TEXT_COLOR)("Connect phone"), fg(MUTED_COLOR)("\n\nPreparing Telegram…")])
    this.footer.content = new StyledText([fg(MUTED_COLOR)("Esc close")])
    this.renderer.requestRender()
  }

  private removeQr(): void {
    if (!this.qr) return
    if (!this.qrSlot.isDestroyed && !this.qr.isDestroyed) this.qrSlot.remove(this.qr)
    if (!this.qr.isDestroyed) this.qr.destroy()
    this.qr = null
  }

  private resizeModal(): void {
    this.modal.width = Math.max(42, Math.min(72, this.root.width - 4))
    this.modal.height = Math.max(16, Math.min(38, this.root.height - 2))
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
