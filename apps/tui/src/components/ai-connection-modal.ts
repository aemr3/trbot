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
import type { AiAccount, AiAuthType, AiProviderSummary, AiSelectOption } from "@trbot/protocol/ai.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c83ff"
const SUCCESS_COLOR = "#70d7a1"
const ERROR_COLOR = "#ff6b6b"
const SELECTED_BG = "#22252d"

/**
 * What the flow is waiting for the trader to do.
 *
 * These are the harness's own prompts rather than any provider's, which is why one
 * modal serves every provider: an API key asks for `secret`, a subscription login
 * asks for `select` then perhaps `code`, and nothing here knows which is which.
 */
type Pending =
  | { kind: "secret"; message: string; typed: string; settle: (value: string) => void }
  | { kind: "code"; message: string; typed: string; settle: (value: string) => void }
  | { kind: "select"; message: string; options: AiSelectOption[]; index: number; settle: (id: string) => void }

export interface AiConnectionModalOptions {
  account: AiAccount
  /** Told when a connection appears or goes, so a screen can re-read its models. */
  onChanged?: () => void
  onClose: () => void
}

/**
 * Connecting model providers.
 *
 * Lists every provider the harness offers and runs whichever flow the chosen one
 * uses. Subscription logins and API keys are the same code path: the flow says what
 * it needs and this renders it.
 */
export class AiConnectionModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable

  private providers: AiProviderSummary[] = []
  private message: string | null = null
  private failed = false
  private authorizationUrl: string | null = null
  private deviceCode: { userCode: string; verificationUri: string } | null = null
  private busy = false
  private pending: Pending | null = null
  private request: AbortController | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AiConnectionModalOptions,
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
      width: 78,
      height: 24,
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
      onSelect: () => this.render(),
      onActivate: () => void this.connectSelected(),
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    void this.load()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.pending) return this.handlePendingKey(key)
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (this.busy) return true
    if (key.name === "return" || key.name === "enter") {
      void this.connectSelected()
      return true
    }
    if (!key.ctrl && !key.meta && !key.option && key.name === "d") {
      void this.disconnectSelected()
      return true
    }
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.settlePending("")
    this.request?.abort()
    this.request = null
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async load(): Promise<void> {
    try {
      this.providers = await this.options.account.providers()
      if (this.destroyed) return
      this.render()
    } catch (error) {
      if (this.destroyed) return
      this.fail(error)
    }
  }

  private selectedProvider(): AiProviderSummary | null {
    return this.providers[this.list.selectedIndex] ?? null
  }

  /**
   * Connects the highlighted provider.
   *
   * A provider offering both a subscription login and an API key is asked about
   * rather than decided for: the two bill differently, so guessing would be choosing
   * how the trader pays.
   */
  private async connectSelected(): Promise<void> {
    const provider = this.selectedProvider()
    if (!provider || this.busy || this.destroyed) return
    if (provider.authTypes.length === 0) {
      this.message = `${provider.name} cannot be connected from here`
      this.failed = true
      this.render()
      return
    }

    const request = new AbortController()
    this.request = request
    this.busy = true
    this.failed = false
    this.message = `Connecting ${provider.name}…`
    this.authorizationUrl = null
    this.deviceCode = null
    this.render()

    try {
      const authType = await this.chooseAuthType(provider)
      const summary = await this.options.account.connect(provider.providerId, authType, {
        signal: request.signal,
        onAuthorizationUrl: (url) => this.update(() => {
          this.authorizationUrl = url
        }),
        onBrowserError: () => this.update(() => {
          this.message = "Could not open the browser. Open the link below."
        }),
        onInfo: (message) => this.update(() => {
          this.message = message
        }),
        onDeviceCode: (code) => this.update(() => {
          this.deviceCode = { userCode: code.userCode, verificationUri: code.verificationUri }
        }),
        onSecret: (message) => this.ask("secret", message),
        onSelect: (message, options) => this.askSelect(message, options),
        onManualCode: (message) => this.ask("code", message),
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.providers = this.providers.map((candidate) =>
        candidate.providerId === summary.providerId ? summary : candidate,
      )
      this.message = `${summary.name} connected.`
      this.authorizationUrl = null
      this.deviceCode = null
      this.options.onChanged?.()
      this.render()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) {
        this.update(() => {
          this.message = null
        })
        return
      }
      this.fail(error)
    } finally {
      if (this.request === request) this.request = null
      this.busy = false
      this.render()
    }
  }

  private async chooseAuthType(provider: AiProviderSummary): Promise<AiAuthType> {
    const [only, second] = provider.authTypes
    if (!only) throw new Error(`${provider.name} has no supported sign-in method`)
    if (!second) return only
    const chosen = await this.askSelect(`How do you want to connect ${provider.name}?`, [
      { id: "oauth", label: provider.isSubscription ? "Sign in (subscription)" : "Sign in" },
      { id: "api_key", label: "API key" },
    ])
    return chosen === "api_key" ? "api_key" : "oauth"
  }

  private async disconnectSelected(): Promise<void> {
    const provider = this.selectedProvider()
    if (!provider || !provider.connected || this.busy || this.destroyed) return
    this.busy = true
    this.message = `Disconnecting ${provider.name}…`
    this.render()
    try {
      await this.options.account.disconnect(provider.providerId)
      if (this.destroyed) return
      this.providers = await this.options.account.providers()
      this.message = `${provider.name} disconnected.`
      this.options.onChanged?.()
      this.render()
    } catch (error) {
      if (this.destroyed) return
      this.fail(error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Waits for something typed in.
   *
   * Resolving with an empty string cancels the login, which is what Esc means here —
   * there is nothing else to fall back to at this point.
   */
  private ask(kind: "secret" | "code", message: string): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.destroyed) {
        resolve("")
        return
      }
      this.pending = { kind, message, typed: "", settle: resolve }
      this.message = null
      this.render()
    })
  }

  private askSelect(message: string, options: AiSelectOption[]): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.destroyed || options.length === 0) {
        resolve("")
        return
      }
      this.pending = { kind: "select", message, options, index: 0, settle: resolve }
      this.message = null
      this.render()
    })
  }

  private handlePendingKey(key: KeyEvent): boolean {
    const pending = this.pending
    if (!pending) return true

    if (key.name === "escape" || key.name === "esc") {
      this.settlePending("")
      this.render()
      return true
    }

    if (pending.kind === "select") {
      if (key.name === "up") pending.index = Math.max(0, pending.index - 1)
      else if (key.name === "down") pending.index = Math.min(pending.options.length - 1, pending.index + 1)
      else if (key.name === "return" || key.name === "enter") {
        const chosen = pending.options[pending.index]
        this.pending = null
        pending.settle(chosen?.id ?? "")
      }
      this.render()
      return true
    }

    if (key.name === "return" || key.name === "enter") {
      this.pending = null
      this.message = "Finishing…"
      pending.settle(pending.typed.trim())
      this.render()
      return true
    }
    if (key.name === "backspace") {
      pending.typed = [...pending.typed].slice(0, -1).join("")
      this.render()
      return true
    }
    if (key.ctrl || key.meta || key.option || !isPrintable(key.sequence)) return true
    pending.typed = `${pending.typed}${key.sequence}`
    this.render()
    return true
  }

  private settlePending(value: string): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    if (pending.kind === "select") pending.settle(value)
    else pending.settle(value)
  }

  private update(change: () => void): void {
    if (this.destroyed) return
    change()
    this.render()
  }

  private fail(cause: unknown): void {
    this.failed = true
    this.message = errorMessage(cause)
    this.render()
  }

  private render(): void {
    this.header.content = new StyledText([
      fg(VALUE_COLOR)("Model providers\n"),
      fg(MUTED_COLOR)(`${this.providers.filter((provider) => provider.connected).length} connected of ${this.providers.length}\n`),
    ])

    this.list.setRows(
      this.providers.map((provider) => ({
        id: provider.providerId,
        content: new StyledText([
          fg(provider.connected ? SUCCESS_COLOR : MUTED_COLOR)(provider.connected ? "● " : "○ "),
          fg(VALUE_COLOR)(provider.name),
          fg(MUTED_COLOR)(providerDetail(provider)),
        ]),
      })),
      undefined,
      { preserveScroll: true },
    )

    this.footer.content = new StyledText(this.footerChunks())
    this.renderer.requestRender()
  }

  /**
   * What is going on, then what to do about it.
   *
   * The address and the device code stay on screen while a prompt is open, because
   * "open this link, then paste the code back" needs both at once — dropping the
   * address the moment the field appears would hide the thing being asked about.
   */
  private footerChunks(): TextChunk[] {
    const chunks: TextChunk[] = []
    if (this.message) chunks.push(fg(this.failed ? ERROR_COLOR : MUTED_COLOR)(`\n${this.message}\n`))
    // A link is its own chunk: putting one inside a template string renders the
    // object rather than the address.
    if (this.authorizationUrl) {
      chunks.push(fg(EMPHASIS_COLOR)(link(this.authorizationUrl)(this.authorizationUrl)), fg(MUTED_COLOR)("\n"))
    }
    if (this.deviceCode) {
      chunks.push(
        fg(VALUE_COLOR)(`Code ${this.deviceCode.userCode} at `),
        fg(EMPHASIS_COLOR)(link(this.deviceCode.verificationUri)(this.deviceCode.verificationUri)),
        fg(MUTED_COLOR)("\n"),
      )
    }

    const pending = this.pending
    if (pending?.kind === "select") {
      chunks.push(
        fg(MUTED_COLOR)(`${pending.message}\n`),
        ...pending.options.map((option, index) =>
          fg(index === pending.index ? EMPHASIS_COLOR : MUTED_COLOR)(
            `${index === pending.index ? "▸ " : "  "}${option.label}\n`,
          ),
        ),
        fg(MUTED_COLOR)("↑↓ choose · Enter confirm · Esc cancel"),
      )
      return chunks
    }
    if (pending) {
      chunks.push(
        fg(MUTED_COLOR)(`${pending.message}\n`),
        // A secret is masked; a pasted authorization code is not, because a trader
        // needs to see whether the paste landed whole.
        fg(VALUE_COLOR)(`${pending.kind === "secret" ? "•".repeat([...pending.typed].length) : pending.typed}▌\n`),
        fg(MUTED_COLOR)("Enter confirm · Esc cancel"),
      )
      return chunks
    }

    const selected = this.selectedProvider()
    chunks.push(
      fg(MUTED_COLOR)(
        selected?.connected
          ? "\nEnter reconnect · d disconnect · ↑↓ provider · Esc close"
          : "\nEnter connect · ↑↓ provider · Esc close",
      ),
    )
    return chunks
  }

  private resizeModal(): void {
    const width = Math.max(40, Math.min(78, this.root.width - 4))
    const height = Math.max(12, Math.min(24, this.root.height - 2))
    this.modal.width = width
    this.modal.height = height
  }
}

/** What a row says after the name: how it is authenticated, or which account. */
function providerDetail(provider: AiProviderSummary): string {
  const parts: string[] = []
  if (provider.isSubscription) parts.push("subscription")
  if (provider.connected && provider.source) parts.push(provider.source)
  if (provider.accountId) parts.push(provider.accountId)
  if (!provider.connected && provider.authTypes.length > 0) {
    parts.push(provider.authTypes.map((type) => (type === "oauth" ? "sign-in" : "API key")).join(" or "))
  }
  return parts.length > 0 ? `  ${parts.join(" · ")}` : ""
}

function isPrintable(sequence: string | undefined): boolean {
  if (!sequence || sequence.length !== 1) return false
  const code = sequence.codePointAt(0) ?? 0
  return code >= 0x20 && code !== 0x7f
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
