import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"

export interface ConnectingScreenOptions {
  /** Where the terminal is trying to reach, so a misconfigured URL is visible. */
  url: string
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const SPINNER_MS = 120

/**
 * Shown while the terminal has not had an answer from the server.
 *
 * Not knowing is its own state, and it is not the same as being signed out: the
 * sign-in screen is an instruction to do something, and asking a trader to
 * re-enter a password because a server is restarting is both wrong and, if they
 * do it, pointless. Nothing here asks for anything — it says what is happening
 * and waits for the server to answer.
 */
export class ConnectingScreen {
  readonly root: BoxRenderable

  private readonly panel: BoxRenderable
  private readonly heading: TextRenderable
  private readonly detail: TextRenderable
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: ConnectingScreenOptions,
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
      height: 7,
    })
    this.heading = new TextRenderable(renderer, { content: this.headingText() })
    this.detail = new TextRenderable(renderer, { content: options.url, fg: "#777777" })

    this.panel.add(this.heading)
    this.panel.add(this.detail)
    this.panel.add(new TextRenderable(renderer, { content: "Ctrl+C to exit", fg: "#777777" }))
    this.root.add(this.panel)
  }

  mount(): void {
    this.timer ??= setInterval(() => {
      this.frame += 1
      this.heading.content = this.headingText()
      this.renderer.requestRender()
    }, SPINNER_MS)
  }

  /**
   * Why the last attempt failed. Shown rather than swallowed: a wrong address or
   * a rejected token never resolves itself, and waiting silently would look the
   * same as a server that is merely slow to come up.
   */
  reportFailure(message: string): void {
    this.detail.content = `${this.options.url} · ${message}`
    this.detail.fg = "#e5c07b"
    this.renderer.requestRender()
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private headingText(): string {
    return `${SPINNER[this.frame % SPINNER.length] ?? ""} Connecting to the trbot server…`
  }
}
