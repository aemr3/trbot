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
import { PasswordInput } from "../components/password-input.ts"
import { signIn, submitOtp } from "../server-session.ts"

type LoginMode = "username" | "password" | "authenticating" | "otp"

export interface LoginScreenOptions {
  initialStatus?: string
  initialUsername?: string
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
  private mode: LoginMode = "username"
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
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
      fg: "#777777",
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
      backgroundColor: "#202020",
      focusedBackgroundColor: "#303030",
      cursorColor: "#70d7a1",
    })
    this.passwordInput = new PasswordInput(renderer)

    this.loginForm.add(
      new TextRenderable(renderer, {
        content: "Username",
        fg: "#aaaaaa",
      }),
    )
    this.loginForm.add(this.usernameInput)
    this.loginForm.add(
      new TextRenderable(renderer, {
        content: "Password",
        fg: "#aaaaaa",
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
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    this.renderer.keyInput.off("paste", this.handlePaste)
    if (!this.usernameInput.isDestroyed) this.usernameInput.value = ""
    this.passwordInput.clear()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
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
    this.status.fg = "#ffffff"

    try {
      await signIn(this.http, username, password)
      this.finishAuthentication()
    } catch (error) {
      if (this.destroyed) return
      if (isProtocolError(error) && error.code === "otp_required") {
        this.showOtpInput()
        return
      }

      this.usernameInput.value = username
      this.passwordInput.clear()
      this.mode = "password"
      this.passwordInput.focus()
      this.status.content = `Authentication failed: ${errorMessage(error)}`
      this.status.fg = "#ff6b6b"
    }
  }

  private showOtpInput(): void {
    this.mode = "otp"
    this.status.content = "Enter the verification code sent by SMS:"
    this.status.fg = "#ffffff"
    this.hint.content = "Enter to verify · Ctrl+C to exit"
    this.usernameInput.value = ""
    this.passwordInput.clear()
    this.panel.remove(this.loginForm)
    this.loginForm.destroyRecursively()

    const otpInput = new InputRenderable(this.renderer, {
      id: "otp",
      width: 16,
      minLength: 4,
      maxLength: 10,
      placeholder: "SMS code",
      backgroundColor: "#202020",
      focusedBackgroundColor: "#303030",
      cursorColor: "#70d7a1",
    })
    otpInput.on(InputRenderableEvents.INPUT, (value: string) => {
      const digits = value.replace(/\D/g, "")
      if (digits !== value) otpInput.value = digits
    })
    otpInput.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.verifyOtp(otpInput, value)
    })
    this.panel.remove(this.hint)
    this.panel.add(otpInput)
    this.panel.add(this.hint)
    otpInput.focus()
  }

  private async verifyOtp(input: InputRenderable, value: string): Promise<void> {
    input.blur()
    this.status.content = "Verifying…"
    this.status.fg = "#ffffff"

    try {
      await submitOtp(this.http, value)
      this.finishAuthentication()
    } catch (error) {
      if (this.destroyed) return
      this.status.content = `Verification failed: ${errorMessage(error)}`
      this.status.fg = "#ff6b6b"
      input.value = ""
      input.focus()
    }
  }

  private finishAuthentication(): void {
    this.options.onAuthenticated()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
