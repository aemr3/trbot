import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { HttpAiAccount, HttpOverviewGenerator } from "@trbot/client/ai.ts"
import {
  HttpAccountSource,
  HttpBrokerageDistributionSource,
  HttpCandleSource,
  HttpInstrumentSource,
  HttpMemberFeatureSource,
  HttpNewsSource,
  HttpOrderSource,
  HttpOverviewSnapshotStore,
  HttpSettlementSource,
  HttpWatchlistPreferences,
} from "@trbot/client/sources.ts"
import { HttpAlerts, HttpStopRules } from "@trbot/client/monitors.ts"
import {
  MonitorClient,
  WsAccountStream,
  WsDepthStream,
  WsEquityQuoteStream,
  WsQuoteStream,
} from "@trbot/client/stream.ts"
import { loadClientConfig } from "@trbot/config"
import type { AiAccount } from "@trbot/protocol/ai.ts"
import { isTransientError, requiresAuthentication } from "@trbot/protocol/error.ts"
import { SystemSoundPlayer, type SoundPlayer } from "./components/sound.ts"
import { ApplicationLog } from "./logging/application-log.ts"
import type { OverviewGenerator, OverviewSnapshotStore } from "@trbot/market/overview.ts"
import { ConnectingScreen } from "./screens/connecting.ts"
import { LoginScreen } from "./screens/login.ts"
import { LogsScreen } from "./screens/logs.ts"
import { TradingWorkspaceScreen } from "./screens/trading-workspace.ts"
import { WatchlistScreen } from "./screens/watchlist.ts"
import { RemoteAlerts, RemoteStopRules } from "./remote-monitors.ts"
import { createServerSession, serverAuthenticated, type ServerSession } from "./server-session.ts"
import type { WatchlistPreferences } from "@trbot/preferences/watchlist.ts"

interface Screen {
  readonly root: BoxRenderable
  mount?(): void
  destroy(): void
}

interface InitialState {
  session: ServerSession
  /**
   * What the server said, or null when it has not answered.
   *
   * Not knowing is its own state. Treating it as "signed out" puts a sign-in
   * screen in front of a trader whose session is fine and whose server is
   * merely restarting — an instruction to do something, about a problem they do
   * not have and cannot fix by doing it.
   */
  authenticated: boolean | null
}

interface AppOptions {
  preferences?: WatchlistPreferences
  /**
   * Fetches the stored settings, for when they were not available at startup.
   *
   * A terminal that starts while the server is restarting cannot read them, and
   * running on defaults would be a silent downgrade — the first thing the trader
   * changed would write those defaults over what they had.
   */
  loadPreferences?: () => Promise<WatchlistPreferences>
  savePreferences?: (preferences: WatchlistPreferences) => void
  closePreferences?: () => void
  exit?: () => void
  aiAccount?: AiAccount
  overview?: OverviewGenerator
  overviewSnapshots?: OverviewSnapshotStore
  sound?: SoundPlayer
  logs?: ApplicationLog
  /** How often to re-ask whether the server has a session. Tests shorten it. */
  sessionPollMs?: number
}

// How often the terminal re-asks whether the server has a session, while the
// sign-in screen is up. Short enough that a server restart is barely noticed.
const SESSION_POLL_MS = 2_000

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
  const initialState = await resolveInitialState()
  let app: App | null = null

  try {
    const http = initialState.session.http
    const preferencesStore = new HttpWatchlistPreferences(http)
    // These are the terminal's own settings, not the provider's, so they load
    // whether or not the server holds a provider session. A terminal that opens
    // on the login screen otherwise starts on defaults and writes them over
    // what was saved as soon as anything is changed.
    const preferences = await preferencesStore.load().catch(() => undefined)
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: EXIT_SIGNALS,
      onDestroy: () => app?.dispose(),
    })
    app = new App(renderer, initialState, {
      preferences,
      loadPreferences: () => preferencesStore.load(),
      savePreferences: (next) => preferencesStore.save(next),
      closePreferences: () => initialState.session.close(),
      // The ChatGPT connection and the model both live on the server; the
      // terminal only asks for the words and shows them.
      aiAccount: new HttpAiAccount(http),
      overviewSnapshots: new HttpOverviewSnapshotStore(http),
      overview: new HttpOverviewGenerator(http),
      // Cues are written through the renderer so a bell never races a frame.
      sound: new SystemSoundPlayer({
        write: (data) => (renderer as unknown as { writeOut(data: string): void }).writeOut(data),
      }),
    })
    app.mount()
  } catch (error) {
    if (app) app.dispose()
    else initialState.session.close()
    throw error
  }
}

/**
 * Opens the link to the server and asks whether it already holds a provider
 * session. The server signs itself in unattended, so the terminal usually finds
 * one waiting.
 */
async function resolveInitialState(): Promise<InitialState> {
  const session = createServerSession({ config: loadClientConfig() })
  try {
    return { session, authenticated: await serverAuthenticated(session.http) }
  } catch {
    // A server that cannot be reached has not said anything, so nothing is
    // decided yet. The application waits for it rather than guessing.
    return { session, authenticated: null }
  }
}

export class App {
  private readonly root: BoxRenderable
  private screen: Screen | null = null
  private session: ServerSession
  private disposed = false
  private shuttingDown = false
  private preferences: WatchlistPreferences | undefined
  /** Whether `preferences` came from the server rather than being unknown. */
  private preferencesLoaded = false
  private readonly fetchPreferences: (() => Promise<WatchlistPreferences>) | undefined
  private readonly persistPreferences: ((preferences: WatchlistPreferences) => void) | undefined
  private readonly closePreferences: (() => void) | undefined
  private readonly exit: () => void
  private readonly aiAccount: AiAccount | undefined
  private readonly overview: OverviewGenerator | undefined
  private readonly overviewSnapshots: OverviewSnapshotStore | undefined
  private readonly sound: SoundPlayer | undefined
  private readonly logs: ApplicationLog
  private readonly stops: RemoteStopRules
  private readonly alerts: RemoteAlerts
  /** The stream adapters this workspace is using; replaced with the workspace. */
  private adapters: { destroy(): void }[] = []
  /** Runs while the sign-in screen is up; see watchForSession. */
  private sessionWatch: ReturnType<typeof setInterval> | null = null
  private readonly sessionPollMs: number

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
    initialState: InitialState,
    options: AppOptions = {},
  ) {
    this.session = initialState.session
    this.preferences = options.preferences
    this.preferencesLoaded = options.preferences !== undefined
    this.fetchPreferences = options.loadPreferences
    this.persistPreferences = options.savePreferences
    this.closePreferences = options.closePreferences
    this.exit = options.exit ?? exitWithSigint
    this.aiAccount = options.aiAccount
    this.overview = options.overview
    this.overviewSnapshots = options.overviewSnapshots
    this.sound = options.sound
    this.logs = options.logs ?? new ApplicationLog()
    this.sessionPollMs = options.sessionPollMs ?? SESSION_POLL_MS

    // Stop rules and price alerts are evaluated by the server so they keep
    // running with no terminal attached. These carry what it reports and send
    // back the trader's decision; they never decide anything themselves.
    const monitors = new MonitorClient(this.session.stream, {
      onStopTriggered: (event, remainingMs, held) => this.stops.acceptTrigger(event, remainingMs, held),
      onStopResolved: (ruleId, outcome) => this.stops.acceptResolved(ruleId, outcome),
      onStopViews: (views) => this.stops.acceptViews(views),
      onAlertTriggered: (event) => this.alerts.acceptTrigger(event),
      onAlertViews: (views) => this.alerts.acceptViews(views),
      onSessionExpired: () => this.showLogin(),
    })
    this.stops = new RemoteStopRules(new HttpStopRules(this.session.http))
    this.alerts = new RemoteAlerts(new HttpAlerts(this.session.http), monitors)

    // A socket failure has nowhere else to surface. The reconnect loop retries
    // silently, so a server that is unreachable — or a certificate the terminal
    // does not trust — otherwise looks exactly like a market with no ticks.
    this.session.onStreamError((error) => this.handleStreamError("Server stream", error))

    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
    })

    if (initialState.authenticated === true && this.preferencesLoaded) {
      this.screen = this.createTradingWorkspace()
    } else {
      // The server said there is no session, or it said nothing at all, or the
      // settings could not be read. All three keep asking; only the first asks
      // the trader for anything.
      this.watchForSession()
      this.screen = initialState.authenticated === false ? this.createLogin() : this.createConnecting()
    }
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
    this.stopWatchingForSession()
    for (const adapter of this.adapters.splice(0)) adapter.destroy()

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

  /**
   * Opens the workspace, reading the stored settings first if startup could not.
   *
   * The layout is part of what the workspace is built from, so it has to be
   * known before there is a workspace. A terminal that starts while the server
   * is restarting has no settings yet, and building on defaults would replace
   * them the first time the trader adjusted anything.
   */
  private async showWatchlist(): Promise<void> {
    if (this.disposed) return
    this.stopWatchingForSession()
    if (!this.preferencesLoaded && this.fetchPreferences) {
      try {
        this.preferences = await this.fetchPreferences()
        this.preferencesLoaded = true
      } catch (error) {
        // Trading matters more than the layout, so the workspace opens anyway —
        // but nothing is written back until a load succeeds.
        this.logs.error("Preferences", error)
      }
      if (this.disposed) return
    }
    this.replaceScreen(this.createTradingWorkspace())
  }

  private createTradingWorkspace(): TradingWorkspaceScreen {
    const http = this.session.http
    const stream = this.session.stream
    // The socket outlives the screens, so the last workspace's adapters are
    // still listening on it — pushing frames into a watchlist that has been
    // destroyed, and one more set of them after every sign-in.
    for (const adapter of this.adapters.splice(0)) adapter.destroy()
    const accountStream = new WsAccountStream(stream)
    const equityQuotes = new WsEquityQuoteStream(stream)
    const quotes = new WsQuoteStream(stream)
    const depth = new WsDepthStream(stream)
    this.adapters = [accountStream, equityQuotes, quotes, depth]

    const orders = new HttpOrderSource(http)
    const instruments = new HttpInstrumentSource(http)
    const candles = new HttpCandleSource(http)
    let workspace: TradingWorkspaceScreen | null = null
    const watchlist = new WatchlistScreen(this.renderer, {
      instruments,
      candles,
      news: new HttpNewsSource(http),
      account: new HttpAccountSource(http),
      orders,
      orderCancellation: orders,
      positionExit: orders,
      accountStream,
      equityQuotes,
      quotes,
      depth,
      brokerage: new HttpBrokerageDistributionSource(http),
      settlement: new HttpSettlementSource(http),
      memberFeatures: new HttpMemberFeatureSource(http),
      preferences: this.preferences,
      onPreferencesChange: (preferences) => {
        this.preferences = preferences
        // Never write settings we could not read: that turns a failed load into
        // a lost configuration the moment the trader adjusts anything.
        if (this.preferencesLoaded) this.persistPreferences?.(preferences)
      },
      onSessionExpired: () => this.showLogin(),
      aiAccount: this.aiAccount,
      overview: this.overview,
      overviewSnapshots: this.overviewSnapshots,
      stops: this.stops,
      alerts: this.alerts,
      sound: this.sound,
      logs: this.logs,
      manageInput: false,
      onOpenLogs: () => workspace?.selectTab("logs"),
    })
    const logs = new LogsScreen(this.renderer, {
      logs: this.logs,
      onClose: () => workspace?.selectTab("watchlist"),
    })
    workspace = new TradingWorkspaceScreen(this.renderer, { watchlist, logs })
    return workspace
  }

  private createLogin(): LoginScreen {
    return new LoginScreen(this.renderer, this.session.http, {
      credentials: null,
      onAuthenticated: () => void this.showWatchlist(),
    })
  }

  private createConnecting(): ConnectingScreen {
    return new ConnectingScreen(this.renderer, { url: this.session.url })
  }

  /**
   * Asks the server where things stand until it says something this terminal can
   * act on, while anything other than the workspace is up.
   *
   * Every transition out of here is the server's answer, never a guess: a
   * session means the workspace, no session means the sign-in screen, and no
   * answer means neither — the server signs itself in unattended and can be
   * restarted underneath a running terminal, so "cannot reach it" is usually a
   * state that fixes itself in seconds and asks nothing of the trader.
   */
  private watchForSession(): void {
    if (this.sessionWatch) return
    this.sessionWatch = setInterval(() => {
      if (this.disposed || this.screen instanceof TradingWorkspaceScreen) {
        this.stopWatchingForSession()
        return
      }
      void serverAuthenticated(this.session.http).then(
        (authenticated) => this.onSessionAnswer(authenticated),
        (error: unknown) => this.onNoAnswer(error),
      )
    }, this.sessionPollMs)
  }

  private onSessionAnswer(authenticated: boolean): void {
    if (this.disposed || this.screen instanceof TradingWorkspaceScreen) return
    if (authenticated) {
      void this.showWatchlist()
      return
    }
    // The server is reachable and holds nothing, so now there is something for
    // the trader to do. A sign-in already on screen is left alone: replacing it
    // would clear a password halfway through being typed.
    if (this.screen instanceof ConnectingScreen) this.replaceScreen(this.createLogin())
  }

  private onNoAnswer(error: unknown): void {
    if (this.disposed) return
    // A sign-in screen the server asked for stays put — the trader may be part
    // way through it, and the poll keeps running underneath either way.
    if (this.screen instanceof ConnectingScreen) this.screen.reportFailure(errorMessage(error))
  }

  private stopWatchingForSession(): void {
    if (!this.sessionWatch) return
    clearInterval(this.sessionWatch)
    this.sessionWatch = null
  }

  private handleStreamError(scope: string, error: unknown): void {
    if (requiresAuthentication(error)) {
      this.showLogin()
      return
    }
    if (!isTransientError(error)) this.logs.error(scope, error)
  }

  /** Only ever called because the server said the session is gone. */
  private showLogin(): void {
    if (this.disposed || this.screen instanceof LoginScreen) return
    this.watchForSession()
    this.replaceScreen(
      new LoginScreen(this.renderer, this.session.http, {
        initialStatus: "Session expired · Sign in",
        credentials: null,
        onAuthenticated: () => void this.showWatchlist(),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
