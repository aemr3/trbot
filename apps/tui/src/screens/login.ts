import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core"
import type { HttpClient } from "@trbot/client/http.ts"
import type { AppCredentials } from "@trbot/config"
import { isProtocolError } from "@trbot/protocol/error.ts"
import type { OtpChallengeState, SessionState } from "@trbot/protocol/routes.ts"
import { PasswordInput } from "../components/password-input.ts"
import { requestNewOtp, serverSessionState, signIn, submitOtp } from "../server-session.ts"

type LoginMode = "username" | "password" | "authenticating" | "otp" | "verifying-otp" | "requesting-otp"

export interface LoginScreenOptions {
  initialStatus?: string
  initialUsername?: string
  initialOtp?: OtpChallengeState | null
  credentials?: AppCredentials | null
  onAuthenticated(): void
}

export class LoginScreen {
  readonly root: BoxRenderable

  private readonly panel: BoxRenderable
  private readonly status: TextRenderable
  private readonly hint: TextRenderable
  private readonly loginForm: BoxRenderable
  private readonly usernameInput: InputRenderable
  private readonly passwordInput: PasswordInput
  private otpInput: InputRenderable | null = null
  private otpExpiresAt: number | null = null
  private otpTimer: ReturnType<typeof setInterval> | null = null
  private otpNotice: string | null = null
  private mode: LoginMode = "username"
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (this.mode === "otp" && key.ctrl && key.name === "r") {
      key.preventDefault()
      key.stopPropagation()
      if (this.otpExpired()) void this.requestReplacementOtp()
      return
    }
    if (this.mode === "username" && key.name === "tab") {
      key.preventDefault()
      this.focusPassword()
      return
    }
    if (this.mode !== "password") return

    const action = this.passwordInput.handleKey(key)
    if (action === "previous") {
      key.preventDefault()
      this.focusUsername()
    } else if (action === "submit") {
      key.preventDefault()
      void this.submitCredentials()
    }
  }

  private readonly handlePaste = (event: PasteEvent): void => {
    if (this.mode !== "password") return
    event.preventDefault()
    this.passwordInput.handlePaste(event)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly http: HttpClient,
    private readonly options: LoginScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
    })
    this.panel = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      flexDirection: "column",
      gap: 1,
      padding: 1,
      title: "trbot",
      width: 52,
      height: 13,
    })
    this.status = new TextRenderable(renderer, {
      content: options.initialStatus ?? "Sign in",
    })
    this.hint = new TextRenderable(renderer, {
      content: "Tab to move · Enter to submit · Ctrl+C to exit",
      fg: TUI_THEME.textSubdued,
    })
    this.loginForm = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      width: "100%",
      height: 5,
    })
    this.usernameInput = new InputRenderable(renderer, {
      id: "username",
      width: 32,
      minLength: 1,
      maxLength: 64,
      placeholder: "+905…",
      backgroundColor: TUI_THEME.controlBackground,
      focusedBackgroundColor: TUI_THEME.border,
      cursorColor: TUI_THEME.positive,
    })
    this.passwordInput = new PasswordInput(renderer)

    this.loginForm.add(
      new TextRenderable(renderer, {
        content: "Username",
        fg: TUI_THEME.textSecondary,
      }),
    )
    this.loginForm.add(this.usernameInput)
    this.loginForm.add(
      new TextRenderable(renderer, {
        content: "Password",
        fg: TUI_THEME.textSecondary,
      }),
    )
    this.loginForm.add(this.passwordInput.renderable)
    this.panel.add(this.status)
    this.panel.add(this.loginForm)
    this.panel.add(this.hint)
    this.root.add(this.panel)

    this.usernameInput.on(InputRenderableEvents.ENTER, () => this.focusPassword())
  }

  mount(): void {
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.renderer.keyInput.on("paste", this.handlePaste)
    if (this.options.initialOtp) {
      this.showOtpInput(this.options.initialOtp)
      return
    }
    const credentials = this.options.credentials
    if (credentials) {
      void this.authenticateWith(credentials.username, credentials.password)
    } else if (this.options.initialUsername) {
      this.usernameInput.value = this.options.initialUsername
      this.focusPassword()
    } else {
      this.usernameInput.focus()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopOtpTimer()
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    this.renderer.keyInput.off("paste", this.handlePaste)
    if (!this.usernameInput.isDestroyed) this.usernameInput.value = ""
    this.passwordInput.clear()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  /** Applies the server's polled login state without replacing partially typed input. */
  acceptSessionState(state: SessionState): void {
    if (state.authenticated) {
      this.finishAuthentication()
      return
    }
    if (state.otp) {
      this.showOtpInput(state.otp)
      return
    }
    if (this.mode === "otp" || this.mode === "verifying-otp" || this.mode === "requesting-otp") {
      this.showCredentials("SMS challenge is no longer available · Sign in")
    }
  }

  private focusUsername(): void {
    this.mode = "username"
    this.passwordInput.blur()
    this.usernameInput.focus()
  }

  private focusPassword(): void {
    if (!this.usernameInput.value.trim()) {
      this.status.content = "Enter your username"
      return
    }
    this.mode = "password"
    this.usernameInput.blur()
    this.passwordInput.focus()
  }

  private async submitCredentials(): Promise<void> {
    const username = this.usernameInput.value.trim()
    const password = this.passwordInput.value
    if (this.mode === "authenticating") return
    if (!username || !password) {
      this.status.content = "Enter both username and password"
      return
    }
    await this.authenticateWith(username, password)
  }

  private async authenticateWith(username: string, password: string): Promise<void> {
    if (this.mode === "authenticating") return
    this.mode = "authenticating"
    this.usernameInput.blur()
    this.passwordInput.blur()
    this.status.content = "Authenticating…"
    this.status.fg = TUI_THEME.textStrong

    try {
      await signIn(this.http, username, password)
      this.finishAuthentication()
    } catch (error) {
      if (this.destroyed) return
      if (isProtocolError(error) && error.code === "otp_required") {
        const state = await serverSessionState(this.http).catch(() => null)
        if (this.destroyed) return
        this.showOtpInput(state?.otp ?? { expiresAt: null })
        return
      }

      this.usernameInput.value = username
      this.passwordInput.clear()
      this.mode = "password"
      this.passwordInput.focus()
      this.status.content = `Authentication failed: ${errorMessage(error)}`
      this.status.fg = TUI_THEME.negative
    }
  }

  private showOtpInput(challenge: OtpChallengeState): void {
    const changed = this.otpExpiresAt !== challenge.expiresAt
    this.otpExpiresAt = challenge.expiresAt
    if (changed) this.otpNotice = null

    if (!this.otpInput) {
      this.usernameInput.value = ""
      this.passwordInput.clear()
      this.panel.remove(this.loginForm)
      this.otpInput = new InputRenderable(this.renderer, {
        id: "otp",
        width: 16,
        minLength: 4,
        maxLength: 10,
        placeholder: "SMS code",
        backgroundColor: TUI_THEME.controlBackground,
        focusedBackgroundColor: TUI_THEME.border,
        cursorColor: TUI_THEME.positive,
      })
      this.otpInput.on(InputRenderableEvents.INPUT, (value: string) => {
        const digits = value.replace(/\D/g, "")
        if (digits !== value && this.otpInput) this.otpInput.value = digits
        this.otpNotice = null
        this.renderOtpStatus()
      })
      this.otpInput.on(InputRenderableEvents.ENTER, (value: string) => {
        if (this.otpInput) void this.verifyOtp(this.otpInput, value)
      })
      this.panel.remove(this.hint)
      this.panel.add(this.otpInput)
      this.panel.add(this.hint)
    }

    if (changed) this.otpInput.value = ""
    if (this.mode !== "verifying-otp" && this.mode !== "requesting-otp") this.mode = "otp"
    if (this.otpExpiresAt === null) this.stopOtpTimer()
    else this.startOtpTimer()
    this.renderOtpStatus()
    if (this.mode === "otp") this.otpInput.focus()
  }

  private async verifyOtp(input: InputRenderable, value: string): Promise<void> {
    if (this.mode !== "otp") return
    if (this.otpExpired()) {
      this.renderOtpStatus()
      return
    }
    this.mode = "verifying-otp"
    input.blur()
    this.status.content = "Verifying…"
    this.status.fg = TUI_THEME.textStrong

    try {
      const state = await submitOtp(this.http, value)
      if (state.authenticated) {
        this.finishAuthentication()
      } else if (state.otp) {
        this.mode = "otp"
        this.showOtpInput(state.otp)
      } else {
        this.showCredentials("No SMS challenge is available · Sign in")
      }
    } catch (error) {
      if (this.destroyed) return
      this.mode = "otp"
      this.otpNotice = `Verification failed: ${errorMessage(error)}`
      input.value = ""
      this.renderOtpStatus()
      input.focus()
    }
  }

  private async requestReplacementOtp(): Promise<void> {
    if (this.mode !== "otp" || !this.otpExpired() || !this.otpInput) return
    this.mode = "requesting-otp"
    this.otpInput.blur()
    this.status.content = "Requesting a new SMS…"
    this.status.fg = TUI_THEME.textStrong

    try {
      const state = await requestNewOtp(this.http)
      if (this.destroyed) return
      if (state.authenticated) {
        this.finishAuthentication()
      } else if (state.otp) {
        this.mode = "otp"
        this.showOtpInput(state.otp)
      } else {
        this.showCredentials("No SMS challenge is available · Sign in")
      }
    } catch (error) {
      if (this.destroyed) return
      this.mode = "otp"
      this.otpNotice = `Could not request a new SMS: ${errorMessage(error)}`
      this.renderOtpStatus()
      this.otpInput.focus()
    }
  }

  private showCredentials(message: string): void {
    this.stopOtpTimer()
    this.otpExpiresAt = null
    this.otpNotice = null
    if (this.otpInput) {
      this.panel.remove(this.otpInput)
      this.otpInput.destroyRecursively()
      this.otpInput = null
    }
    this.panel.remove(this.hint)
    this.panel.add(this.loginForm)
    this.panel.add(this.hint)
    this.status.content = message
    this.status.fg = TUI_THEME.textStrong
    this.hint.content = "Tab to move · Enter to submit · Ctrl+C to exit"
    this.mode = "username"
    this.usernameInput.focus()
  }

  private otpExpired(): boolean {
    return this.otpExpiresAt !== null && this.otpExpiresAt <= Date.now()
  }

  private renderOtpStatus(): void {
    if (this.mode !== "otp") return
    if (this.otpExpired()) {
      this.status.content = this.otpNotice
        ? `${this.otpNotice}\nThe SMS code has expired.`
        : "The SMS code has expired."
      this.status.fg = this.otpNotice ? TUI_THEME.negative : TUI_THEME.textStrong
      this.hint.content = "Ctrl+R to request a new SMS · Ctrl+C to exit"
      return
    }

    const remaining = this.otpExpiresAt === null
      ? ""
      : ` · Expires in ${formatOtpRemaining(this.otpExpiresAt - Date.now())}`
    this.status.content = this.otpNotice ?? `Enter the verification code sent by SMS${remaining}`
    this.status.fg = this.otpNotice ? TUI_THEME.negative : TUI_THEME.textStrong
    this.hint.content = "Enter to verify · Ctrl+C to exit"
  }

  private startOtpTimer(): void {
    if (this.otpTimer || this.otpExpiresAt === null) return
    this.otpTimer = setInterval(() => this.renderOtpStatus(), 1_000)
  }

  private stopOtpTimer(): void {
    if (!this.otpTimer) return
    clearInterval(this.otpTimer)
    this.otpTimer = null
  }

  private finishAuthentication(): void {
    this.stopOtpTimer()
    this.options.onAuthenticated()
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatOtpRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}
