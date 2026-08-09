import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { CredentialsRequiredError, resumeApiClient, type ApiClientHandle } from "./api/index.ts"
import { loadConfig, type AppConfig } from "./config.ts"
import { openDatabase, type DatabaseConnection } from "./db/client.ts"
import { DrizzleWatchlistPreferencesStore } from "./db/watchlist-preferences-store.ts"
import { ApiCandleSource } from "./market/api-candles.ts"
import { ApiNewsSource } from "./market/api-news.ts"
import { ApiEquityQuoteStream } from "./market/equity-quote-stream.ts"
import { ApiQuoteStream } from "./market/quote-stream.ts"
import { ApiViopInstrumentSource } from "./market/api-source.ts"
import { LoginScreen } from "./screens/login.ts"
import { WatchlistScreen } from "./screens/watchlist.ts"
import type { WatchlistPreferences } from "./screens/watchlist-preferences.ts"
import { ApiAccountSource } from "./trading/api-account.ts"
import { ApiAccountStream } from "./trading/api-account-stream.ts"
import { ApiViopOrderSource } from "./trading/api-order.ts"

interface Screen {
  readonly root: BoxRenderable
  mount?(): void
  destroy(): void
}

interface InitialState {
  api: ApiClientHandle | null
  sessionExpired: boolean
}

interface AppOptions {
  preferences?: WatchlistPreferences
  savePreferences?: (preferences: WatchlistPreferences) => void
  closePreferences?: () => void
  exit?: () => void
}

const EXIT_SIGNALS: NodeJS.Signals[] = [
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGHUP",
  "SIGBREAK",
  "SIGPIPE",
  "SIGBUS",
]

export async function startApp(): Promise<void> {
  const config = loadConfig()
  const initialState = await resolveInitialState(config)
  let app: App | null = null
  let preferencesConnection: DatabaseConnection | null = null

  try {
    preferencesConnection = await openDatabase(config.databaseUrl)
    const preferencesStore = new DrizzleWatchlistPreferencesStore(preferencesConnection.db)
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: EXIT_SIGNALS,
      onDestroy: () => app?.dispose(),
    })
    app = new App(renderer, config, initialState, {
      preferences: preferencesStore.get(),
      savePreferences: (preferences) => preferencesStore.put(preferences),
      closePreferences: preferencesConnection.close,
    })
    app.mount()
  } catch (error) {
    if (app) app.dispose()
    else {
      initialState.api?.close()
      preferencesConnection?.close()
    }
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

export class App {
  private readonly root: BoxRenderable
  private screen: Screen | null = null
  private api: ApiClientHandle | null
  private disposed = false
  private shuttingDown = false
  private preferences: WatchlistPreferences | undefined
  private readonly persistPreferences: ((preferences: WatchlistPreferences) => void) | undefined
  private readonly closePreferences: (() => void) | undefined
  private readonly exit: () => void

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (!key.ctrl || key.name !== "c") return
    key.preventDefault()
    key.stopPropagation()
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.shutdown()
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly config: AppConfig,
    initialState: InitialState,
    options: AppOptions = {},
  ) {
    this.api = initialState.api
    this.preferences = options.preferences
    this.persistPreferences = options.savePreferences
    this.closePreferences = options.closePreferences
    this.exit = options.exit ?? exitWithSigint
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
    this.closePreferences?.()

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
      candles: new ApiCandleSource(api.client),
      news: new ApiNewsSource(api.client),
      account: new ApiAccountSource(api.client),
      orders: new ApiViopOrderSource(api.client),
      accountStream: new ApiAccountStream(api.client, {
        onError: (error) => {
          if (error instanceof CredentialsRequiredError) this.showLogin()
        },
      }),
      equityQuotes: new ApiEquityQuoteStream(api.client, {
        onError: (error) => {
          if (error instanceof CredentialsRequiredError) this.showLogin()
        },
      }),
      quotes: new ApiQuoteStream(api.client, {
        onError: (error) => {
          if (error instanceof CredentialsRequiredError) this.showLogin()
        },
      }),
      preferences: this.preferences,
      onPreferencesChange: (preferences) => {
        this.preferences = preferences
        this.persistPreferences?.(preferences)
      },
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
    this.exit()
  }
}

function exitWithSigint(): void {
  process.kill(process.pid, "SIGINT")
}
