import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { ChatGptAccountService, type ChatGptAccount } from "./ai/chatgpt-account.ts"
import {
  ApiHttpError,
  createApiClient,
  requiresAuthentication,
  resumeApiClient,
  type ApiClientHandle,
} from "./api/index.ts"
import { isTransientStreamError } from "./api/transport.ts"
import { loadConfig, type AppConfig, type AppCredentials } from "./config.ts"
import { openDatabase, type DatabaseConnection } from "./db/client.ts"
import { DrizzleProviderStateStore } from "./db/provider-state-store.ts"
import { DrizzleWatchlistPreferencesStore } from "./db/watchlist-preferences-store.ts"
import { ApplicationLog } from "./logging/application-log.ts"
import { ApiCandleSource } from "./market/api-candles.ts"
import { ApiDepthStream } from "./market/api-depth-stream.ts"
import { ApiNewsSource } from "./market/api-news.ts"
import { ApiEquityQuoteStream } from "./market/equity-quote-stream.ts"
import { ApiQuoteStream } from "./market/quote-stream.ts"
import { ApiViopInstrumentSource } from "./market/api-source.ts"
import { ApiMemberFeatureSource } from "./member/api-features.ts"
import { LoginScreen } from "./screens/login.ts"
import { LogsScreen } from "./screens/logs.ts"
import { TradingWorkspaceScreen } from "./screens/trading-workspace.ts"
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
  chatGptAccount?: ChatGptAccount
  logs?: ApplicationLog
  recoverSession?: (credentials: AppCredentials) => Promise<ApiClientHandle>
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
const SESSION_RATE_LIMIT_RETRY_MS = 30_000

export async function startApp(): Promise<void> {
  const config = loadConfig()
  const initialState = await resolveInitialState(config)
  let app: App | null = null
  let preferencesConnection: DatabaseConnection | null = null

  try {
    preferencesConnection = await openDatabase(config.databaseUrl)
    const preferencesStore = new DrizzleWatchlistPreferencesStore(preferencesConnection.db)
    const chatGptAccount = new ChatGptAccountService(new DrizzleProviderStateStore(preferencesConnection.db))
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: EXIT_SIGNALS,
      onDestroy: () => app?.dispose(),
    })
    app = new App(renderer, config, initialState, {
      preferences: preferencesStore.get(),
      savePreferences: (preferences) => preferencesStore.put(preferences),
      closePreferences: preferencesConnection.close,
      chatGptAccount,
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
  private workspace: TradingWorkspaceScreen | null = null
  private api: ApiClientHandle | null
  private sessionRecovery: Promise<void> | null = null
  private sessionRetryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private shuttingDown = false
  private preferences: WatchlistPreferences | undefined
  private readonly persistPreferences: ((preferences: WatchlistPreferences) => void) | undefined
  private readonly closePreferences: (() => void) | undefined
  private readonly exit: () => void
  private readonly chatGptAccount: ChatGptAccount | undefined
  private readonly logs: ApplicationLog
  private readonly recoverSession: (credentials: AppCredentials) => Promise<ApiClientHandle>

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
    this.chatGptAccount = options.chatGptAccount
    this.logs = options.logs ?? new ApplicationLog()
    this.recoverSession = options.recoverSession ?? ((credentials) => authenticateApiClient(config, credentials))
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
    })

    this.screen = this.api
      ? this.createTradingWorkspace(this.api)
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
    if (this.sessionRetryTimer) clearTimeout(this.sessionRetryTimer)
    this.sessionRetryTimer = null
    this.api?.close()
    this.api = null
    this.workspace = null

    if (this.screen) {
      if (!this.renderer.isDestroyed) this.root.remove(this.screen.root)
      this.screen.destroy()
      this.screen = null
    }
    this.closePreferences?.()
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
    this.replaceScreen(this.createTradingWorkspace(api))
  }

  private createTradingWorkspace(api: ApiClientHandle): TradingWorkspaceScreen {
    const orders = new ApiViopOrderSource(api.client)
    const instruments = new ApiViopInstrumentSource(api.client)
    const candles = new ApiCandleSource(api.client)
    let workspace: TradingWorkspaceScreen | null = null
    const watchlist = new WatchlistScreen(this.renderer, {
      instruments,
      candles,
      news: new ApiNewsSource(api.client),
      account: new ApiAccountSource(api.client),
      orders,
      orderCancellation: orders,
      positionExit: orders,
      accountStream: new ApiAccountStream(api.client, {
        onError: (error) => this.handleStreamError("Account stream", error),
      }),
      equityQuotes: new ApiEquityQuoteStream(api.client, {
        onError: (error) => this.handleStreamError("Equity quote stream", error),
      }),
      quotes: new ApiQuoteStream(api.client, {
        onError: (error) => this.handleStreamError("VIOP quote stream", error),
      }),
      depth: new ApiDepthStream(api.client, {
        onError: (error) => this.handleStreamError("Depth stream", error),
      }),
      memberFeatures: new ApiMemberFeatureSource(api.client),
      preferences: this.preferences,
      onPreferencesChange: (preferences) => {
        this.preferences = preferences
        this.persistPreferences?.(preferences)
      },
      onSessionExpired: () => this.showLogin(),
      chatGptAccount: this.chatGptAccount,
      logs: this.logs,
      manageInput: false,
      onOpenLogs: () => workspace?.selectTab("logs"),
    })
    const logs = new LogsScreen(this.renderer, {
      logs: this.logs,
      onClose: () => workspace?.selectTab("watchlist"),
    })
    workspace = new TradingWorkspaceScreen(this.renderer, { watchlist, logs })
    this.workspace = workspace
    return workspace
  }

  private handleStreamError(scope: string, error: unknown): void {
    if (requiresAuthentication(error)) {
      this.showLogin()
      return
    }
    if (!isTransientStreamError(error)) this.logs.error(scope, error)
  }

  private showLogin(): void {
    if (this.disposed || !this.api || this.sessionRecovery) return
    const credentials = this.config.credentials
    if (!credentials) {
      this.transitionToLogin()
      return
    }

    this.workspace?.setStatus("SESSION · reconnecting…", "#e5c07b")
    this.sessionRecovery = Promise.resolve()
      .then(() => this.recoverSession(credentials))
      .then(
        (api) => {
          this.sessionRecovery = null
          if (this.disposed) api.close()
          else this.showWatchlist(api)
        },
        (error) => {
          this.sessionRecovery = null
          this.logs.error("Session recovery", error)
          if (this.disposed) return
          if (error instanceof ApiHttpError && error.status === 429) {
            const retryMs = error.retryAfterMs ?? SESSION_RATE_LIMIT_RETRY_MS
            const retrySeconds = Math.max(1, Math.ceil(retryMs / 1_000))
            this.workspace?.setStatus(`SESSION · rate limited · retrying in ${retrySeconds}s`, "#e5c07b")
            this.sessionRetryTimer = setTimeout(() => {
              this.sessionRetryTimer = null
              this.showLogin()
            }, retryMs)
            return
          }
          this.transitionToLogin(credentials.username)
        },
      )
  }

  private transitionToLogin(initialUsername?: string): void {
    if (this.disposed || !this.api) return
    if (this.sessionRetryTimer) clearTimeout(this.sessionRetryTimer)
    this.sessionRetryTimer = null
    this.api.close()
    this.api = null
    this.workspace = null
    this.replaceScreen(
      new LoginScreen(this.renderer, this.config, {
        initialStatus: "Session expired · Sign in",
        initialUsername,
        credentials: null,
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

async function authenticateApiClient(config: AppConfig, credentials: AppCredentials): Promise<ApiClientHandle> {
  const api = await createApiClient(config, credentials)
  try {
    await api.client.reauthenticate()
    return api
  } catch (error) {
    api.close()
    throw error
  }
}
