import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { resumeApiClient, type ApiClientHandle } from "./api/index.ts"
import { loadConfig, type AppConfig } from "./config.ts"
import { ApiNewsSource } from "./market/api-news.ts"
import { ApiViopInstrumentSource } from "./market/api-source.ts"
import { LoginScreen } from "./screens/login.ts"
import { WatchlistScreen } from "./screens/watchlist.ts"

interface Screen {
  readonly root: BoxRenderable
  mount?(): void
  destroy(): void
}

interface InitialState {
  api: ApiClientHandle | null
  sessionExpired: boolean
}

export async function startApp(): Promise<void> {
  const config = loadConfig()
  const initialState = await resolveInitialState(config)
  let app: App | null = null

  try {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      onDestroy: () => app?.dispose(),
    })
    app = new App(renderer, config, initialState)
    app.mount()
  } catch (error) {
    if (!app) initialState.api?.close()
    throw error
  }
}

async function resolveInitialState(config: AppConfig): Promise<InitialState> {
  const api = await resumeApiClient(config)
  if (!api) return { api: null, sessionExpired: false }

  try {
    await api.client.authenticate()
    return { api, sessionExpired: false }
  } catch {
    api.close()
    return { api: null, sessionExpired: true }
  }
}

class App {
  private readonly root: BoxRenderable
  private screen: Screen | null = null
  private api: ApiClientHandle | null
  private disposed = false
  private shuttingDown = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (!key.ctrl || key.name !== "c") return
    key.preventDefault()
    key.stopPropagation()
    if (this.shuttingDown) return
    this.shuttingDown = true
    queueMicrotask(() => this.shutdown())
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly config: AppConfig,
    initialState: InitialState,
  ) {
    this.api = initialState.api
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
    })

    this.screen = this.api
      ? this.createWatchlistScreen(this.api)
      : new LoginScreen(renderer, config, {
          initialStatus: initialState.sessionExpired ? "Session expired · Sign in" : undefined,
          credentials: config.credentials,
          onAuthenticated: (api) => this.showWatchlist(api),
        })
  }

  mount(): void {
    if (!this.screen) return
    this.renderer.root.add(this.root)
    this.root.add(this.screen.root)
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.screen.mount?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    this.api?.close()
    this.api = null

    if (this.screen) {
      if (!this.renderer.isDestroyed) this.root.remove(this.screen.root)
      this.screen.destroy()
      this.screen = null
    }
    if (this.renderer.isDestroyed) return
    this.renderer.root.remove(this.root)
    this.root.destroyRecursively()
  }

  private showWatchlist(api: ApiClientHandle): void {
    if (this.disposed) {
      api.close()
      return
    }

    this.api?.close()
    this.api = api
    this.replaceScreen(this.createWatchlistScreen(api))
  }

  private createWatchlistScreen(api: ApiClientHandle): WatchlistScreen {
    return new WatchlistScreen(this.renderer, {
      instruments: new ApiViopInstrumentSource(api.client),
      news: new ApiNewsSource(api.client),
      onSessionExpired: () => this.showLogin(),
    })
  }

  private showLogin(): void {
    if (this.disposed) return
    this.api?.close()
    this.api = null
    this.replaceScreen(
      new LoginScreen(this.renderer, this.config, {
        initialStatus: "Session expired · Sign in",
        credentials: this.config.credentials,
        onAuthenticated: (api) => this.showWatchlist(api),
      }),
    )
  }

  private replaceScreen(next: Screen): void {
    if (this.screen) {
      this.root.remove(this.screen.root)
      this.screen.destroy()
    }
    this.screen = next
    this.root.add(next.root)
    next.mount?.()
  }

  private shutdown(): void {
    this.dispose()
    this.renderer.destroy()
    queueMicrotask(() => process.kill(process.pid, "SIGINT"))
  }
}
