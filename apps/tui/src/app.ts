import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type CliRendererErrorEvent,
  type KeyEvent,
} from "@opentui/core"
import { HttpAiAccount } from "@trbot/client/ai.ts"
import { ChatClient, HttpChatSessions } from "@trbot/client/chat.ts"
import {
  HttpAccountSource,
  HttpBrokerageDistributionSource,
  HttpCandleSource,
  HttpInstrumentSource,
  HttpMemberFeatureSource,
  HttpNewsSource,
  HttpOrderSource,
  HttpSettlementSource,
  HttpAppPreferences,
} from "@trbot/client/sources.ts"
import { HttpAlerts, HttpMarketMonitors, HttpStopRules } from "@trbot/client/monitors.ts"
import {
  MonitorClient,
  WsAccountStream,
  WsDepthStream,
  WsEquityQuoteStream,
  WsQuoteStream,
} from "@trbot/client/stream.ts"
import { loadClientConfig, loadPerformanceConfig } from "@trbot/config"
import type { AiAccount } from "@trbot/protocol/ai.ts"
import { isTransientError, requiresAuthentication } from "@trbot/protocol/error.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import { SystemSoundPlayer, type SoundPlayer } from "./components/sound.ts"
import { rendererOutput } from "./renderer-output.ts"
import { copySelection, SystemClipboard, type ClipboardWriter, type SelectionReader } from "./clipboard.ts"
import { ApplicationLog } from "./logging/application-log.ts"
import { ConnectingScreen } from "./screens/connecting.ts"
import { LoginScreen } from "./screens/login.ts"
import { ChatScreen } from "./screens/chat.ts"
import { LogsScreen } from "./screens/logs.ts"
import { TradingWorkspaceScreen } from "./screens/trading-workspace.ts"
import { TradeScreen } from "./screens/trade.ts"
import { RemoteAlerts, RemoteStopRules } from "./remote-monitors.ts"
import { createServerSession, serverAuthenticated, type ServerSession } from "./server-session.ts"
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from "@trbot/preferences/app.ts"
import { PerformanceTelemetry, type PerformanceRecorder } from "@trbot/telemetry/performance.ts"
import { observeRendererPerformance } from "./performance.ts"

interface Screen {
  readonly root: BoxRenderable
  mount?(): void
  /** Clears focused text that should take precedence over quitting. */
  clearInputOnInterrupt?(): boolean
  /** Shows or hides the brief confirmation for a second Ctrl+C. */
  setQuitConfirmation?(visible: boolean): void
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
  preferences?: AppPreferences
  /**
   * Fetches the stored settings, for when they were not available at startup.
   *
   * A terminal that starts while the server is restarting cannot read them, and
   * running on defaults would be a silent downgrade — the first thing the trader
   * changed would write those defaults over what they had.
   */
  loadPreferences?: () => Promise<AppPreferences>
  savePreferences?: (preferences: AppPreferences) => void
  closePreferences?: () => void
  exit?: () => void
  aiAccount?: AiAccount
  sound?: SoundPlayer
  clipboard?: ClipboardWriter
  selection?: SelectionReader
  logs?: ApplicationLog
  /** How often to re-ask whether the server has a session. Tests shorten it. */
  sessionPollMs?: number
  performance?: PerformanceRecorder
}

// How often the terminal re-asks whether the server has a session, while the
// sign-in screen is up. Short enough that a server restart is barely noticed.
const SESSION_POLL_MS = 2_000
const QUIT_CONFIRMATION_MS = 1_500
const TMUX_CAPABILITY_SETTLE_MS = 250
const XTERM_MODIFY_OTHER_KEYS_LEVEL_2 = "\x1b[>4;2m"
const XTERM_MODIFY_OTHER_KEYS_RESET = "\x1b[>4;0m"

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
  const logs = new ApplicationLog()
  const performanceConfig = loadPerformanceConfig()
  const telemetry = performanceConfig.enabled
    ? new PerformanceTelemetry({
        scope: "tui",
        onReport: (report) => logs.info("Performance", "1-minute performance summary", report),
      })
    : null
  const initialState = await resolveInitialState(telemetry ?? undefined)
  telemetry?.start()
  let app: App | null = null
  let renderer: CliRenderer | null = null
  let restoreTmuxKeyboard = (): void => {}

  try {
    const http = initialState.session.http
    const preferencesStore = new HttpAppPreferences(http)
    // These are the terminal's own settings, not the provider's, so they load
    // whether or not the server holds a provider session. A terminal that opens
    // on the login screen otherwise starts on defaults and writes them over
    // what was saved as soon as anything is changed.
    const preferences = await preferencesStore.load().catch(() => undefined)
    const createdRenderer = await createCliRenderer({
      consoleMode: "disabled",
      exitOnCtrlC: false,
      exitSignals: EXIT_SIGNALS,
      gatherStats: telemetry !== null,
      maxFps: 30,
      openConsoleOnError: false,
      targetFps: 30,
      onDestroy: () => {
        restoreTmuxKeyboard()
        app?.dispose()
        telemetry?.stop()
      },
    })
    renderer = createdRenderer
    restoreTmuxKeyboard = configureTmuxKeyboard(createdRenderer)
    app = new App(createdRenderer, initialState, {
      preferences,
      loadPreferences: () => preferencesStore.load(),
      savePreferences: (next) => preferencesStore.save(next),
      closePreferences: () => initialState.session.close(),
      // The ChatGPT connection and the model both live on the server; the
      // terminal only asks for the words and shows them.
      aiAccount: new HttpAiAccount(http),
      // Cues are written through the renderer so a bell never races a frame.
      sound: new SystemSoundPlayer({
        write: (data) => rendererOutput(createdRenderer).writeOut(data),
      }),
      logs,
      performance: telemetry ?? undefined,
    })
    app.mount()
  } catch (error) {
    renderer?.destroy()
    app?.dispose()
    telemetry?.stop()
    if (!app) initialState.session.close()
    throw error
  }
}

interface ServerFrameSource {
  on(listener: (frame: ServerFrame) => void): () => void
}

/** Writes server-side performance windows into the terminal's Logs screen. */
export function forwardServerPerformance(stream: ServerFrameSource, logs: ApplicationLog): () => void {
  return stream.on((frame) => {
    if (frame.type === "performanceReport") {
      logs.info("Server performance", "1-minute performance summary", frame.report)
    }
  })
}

/**
 * tmux's level 1 extended-key mode still encodes Ctrl+M as Return. Level 2
 * distinguishes them. Wait until OpenTUI's startup replies have gone quiet:
 * switching sooner makes tmux reinterpret graphics replies as typed text.
 * OpenTUI restores its own terminal modes when focus returns, so reapply ours
 * after that event. Undo only this extra mode after OpenTUI cleans up.
 */
interface TmuxKeyboardOptions {
  inTmux?: boolean
  settleMs?: number
  write?: (data: string) => void
  restore?: (data: string) => void
}

export function configureTmuxKeyboard(renderer: CliRenderer, options: TmuxKeyboardOptions = {}): () => void {
  const settleMs = options.settleMs ?? TMUX_CAPABILITY_SETTLE_MS
  const write = options.write ?? ((data: string) => rendererOutput(renderer).writeOut(data))
  const restore = options.restore ?? ((data: string) => void process.stdout.write(data))
  let tmux = options.inTmux ?? (process.env.TMUX !== undefined || renderer.capabilities?.multiplexer === "tmux")
  let enabled = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const enable = (): void => {
    renderer.off(CliRenderEvents.CAPABILITIES, observeCapabilities)
    settleTimer = null
    enabled = true
    write(XTERM_MODIFY_OTHER_KEYS_LEVEL_2)
  }
  const scheduleEnable = (): void => {
    if (!tmux || enabled) return
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(enable, settleMs)
  }
  const observeCapabilities = (capabilities: NonNullable<CliRenderer["capabilities"]>): void => {
    if (capabilities.multiplexer !== "tmux") return
    tmux = true
    scheduleEnable()
  }
  const reapplyOnFocus = (): void => {
    if (tmux && enabled) write(XTERM_MODIFY_OTHER_KEYS_LEVEL_2)
  }
  renderer.once(CliRenderEvents.FRAME, scheduleEnable)
  renderer.on(CliRenderEvents.CAPABILITIES, observeCapabilities)
  renderer.on(CliRenderEvents.FOCUS, reapplyOnFocus)

  return () => {
    renderer.off(CliRenderEvents.FRAME, scheduleEnable)
    renderer.off(CliRenderEvents.CAPABILITIES, observeCapabilities)
    renderer.off(CliRenderEvents.FOCUS, reapplyOnFocus)
    if (settleTimer) clearTimeout(settleTimer)
    if (!enabled) return
    // onDestroy runs after OpenTUI restores stdout, so this becomes the final
    // mode change seen by tmux and cannot leak extended input into the shell.
    restore(XTERM_MODIFY_OTHER_KEYS_RESET)
  }
}

/**
 * Opens the link to the server and asks whether it already holds a provider
 * session. The server signs itself in unattended, so the terminal usually finds
 * one waiting.
 */
async function resolveInitialState(performance?: PerformanceRecorder): Promise<InitialState> {
  const session = createServerSession({ config: loadClientConfig(), performance })
  try {
    return { session, authenticated: await serverAuthenticated(session.http) }
  } catch {
    // A server that cannot be reached has not said anything, so nothing is
    // decided yet. The application waits for it rather than guessing.
    return { session, authenticated: null }
  }
}

export class App {
  readonly root: BoxRenderable
  private screen: Screen | null = null
  private session: ServerSession
  private disposed = false
  private shuttingDown = false
  private preferences: AppPreferences | undefined
  /** Whether `preferences` came from the server rather than being unknown. */
  private preferencesLoaded = false
  private readonly fetchPreferences: (() => Promise<AppPreferences>) | undefined
  private readonly persistPreferences: ((preferences: AppPreferences) => void) | undefined
  private readonly closePreferences: (() => void) | undefined
  private readonly exit: () => void
  private readonly aiAccount: AiAccount | undefined
  private readonly sound: SoundPlayer | undefined
  private readonly clipboard: ClipboardWriter
  private readonly selection: SelectionReader
  private readonly logs: ApplicationLog
  private readonly stops: RemoteStopRules
  private readonly alerts: RemoteAlerts
  /** The stream adapters this workspace is using; replaced with the workspace. */
  private adapters: { destroy(): void }[] = []
  /** Runs while the sign-in screen is up; see watchForSession. */
  private sessionWatch: ReturnType<typeof setInterval> | null = null
  private quitConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private quitConfirmationAt: number | null = null
  private readonly sessionPollMs: number
  private readonly detachPerformance: () => void
  private readonly detachServerPerformance: () => void

  private readonly handleKeypress = (key: KeyEvent): void => {
    const copyShortcut = key.name === "c" && (key.ctrl || key.meta || key.super)
    if (copyShortcut && this.copySelection()) {
      this.resetQuitConfirmation()
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (!key.ctrl || key.name !== "c") {
      this.resetQuitConfirmation()
      return
    }
    key.preventDefault()
    key.stopPropagation()
    if (this.shuttingDown) return
    if (this.screen?.clearInputOnInterrupt?.()) {
      this.resetQuitConfirmation()
      return
    }
    if (key.repeated) return

    const now = Date.now()
    if (this.quitConfirmationAt === null || now - this.quitConfirmationAt > QUIT_CONFIRMATION_MS) {
      this.armQuitConfirmation(now)
      return
    }

    this.resetQuitConfirmation()
    this.shuttingDown = true
    this.shutdown()
  }

  private readonly handleRendererError = ({ error }: CliRendererErrorEvent): void => {
    this.logs.error("Renderer", error)
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
    this.sound = options.sound
    this.clipboard = options.clipboard ?? new SystemClipboard(renderer)
    this.selection = options.selection ?? renderer
    this.logs = options.logs ?? new ApplicationLog()
    this.detachServerPerformance = forwardServerPerformance(this.session.stream, this.logs)
    this.sessionPollMs = options.sessionPollMs ?? SESSION_POLL_MS
    this.detachPerformance = options.performance
      ? observeRendererPerformance(renderer, options.performance)
      : () => {}
    this.renderer.on(CliRenderEvents.RENDER_ERROR, this.handleRendererError)

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
      onMouseUp: () => this.copySelection(),
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
    this.renderer.off(CliRenderEvents.RENDER_ERROR, this.handleRendererError)
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    this.detachPerformance()
    this.detachServerPerformance()
    this.resetQuitConfirmation()
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
  async openWorkspace(): Promise<void> {
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
    const chats = new HttpChatSessions(http)
    const marketMonitors = new HttpMarketMonitors(http)
    let workspace: TradingWorkspaceScreen | null = null
    let mainChat: ChatScreen
    let tradePanelChat: ChatScreen
    let selectContract = (_symbol: string, _focusInstrument: boolean): void => {}

    const saveChatSelection = (
      key: "selectedMainChatSessionId" | "selectedTradePanelChatSessionId",
      sessionId: string | null,
    ): void => {
      const current = this.preferences ?? DEFAULT_APP_PREFERENCES
      workspace?.syncQuestionNotifications()
      workspace?.syncPermissionNotifications()
      if (current[key] === sessionId) return
      const next = { ...current, [key]: sessionId }
      this.preferences = next
      if (this.preferencesLoaded) this.persistPreferences?.(next)
    }
    const saveThoughtVisibility = (source: ChatScreen, showChatThoughts: boolean): void => {
      const current = this.preferences ?? DEFAULT_APP_PREFERENCES
      const other = source === mainChat ? tradePanelChat : mainChat
      other.setShowThoughts(showChatThoughts)
      if (current.showChatThoughts === showChatThoughts) return
      const next = { ...current, showChatThoughts }
      this.preferences = next
      if (this.preferencesLoaded) this.persistPreferences?.(next)
    }

    const accountOption = this.aiAccount ? { account: this.aiAccount } : {}
    mainChat = new ChatScreen(this.renderer, {
      chats,
      marketMonitors,
      ...accountOption,
      sound: this.sound,
      logs: this.logs,
      initialSessionId: this.preferences?.selectedMainChatSessionId,
      initialShowThoughts: this.preferences?.showChatThoughts,
      onSessionChange: (sessionId) => saveChatSelection("selectedMainChatSessionId", sessionId),
      onShowThoughtsChange: (showChatThoughts) => saveThoughtVisibility(mainChat, showChatThoughts),
      onQuestionPending: (request) => workspace?.notifyQuestion(request),
      onQuestionResolved: (requestId) => workspace?.resolveQuestion(requestId),
      onPermissionPending: (request) => workspace?.notifyPermission(request),
      onPermissionResolved: (requestId) => workspace?.resolvePermission(requestId),
      onNotification: (notification) => workspace?.notifyAgent(notification),
      onNotificationDismissed: (notificationId) => workspace?.resolveAgentNotification(notificationId),
      onContractSelect: (symbol) => selectContract(symbol, true),
    })
    tradePanelChat = new ChatScreen(this.renderer, {
      chats,
      embedded: true,
      marketMonitors,
      ...accountOption,
      logs: this.logs,
      initialSessionId: this.preferences?.selectedTradePanelChatSessionId,
      initialShowThoughts: this.preferences?.showChatThoughts,
      onSessionChange: (sessionId) => saveChatSelection("selectedTradePanelChatSessionId", sessionId),
      onShowThoughtsChange: (showChatThoughts) => saveThoughtVisibility(tradePanelChat, showChatThoughts),
      onContractSelect: (symbol) => selectContract(symbol, false),
    })

    const chatViews = [mainChat, tradePanelChat]
    const trade = new TradeScreen(this.renderer, {
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
        // Each chat view owns its session, and both own thought visibility. A trade-screen
        // update carries the copy it opened with, so preserve newer chat choices.
        const next = {
          ...preferences,
          selectedMainChatSessionId:
            this.preferences === undefined
              ? preferences.selectedMainChatSessionId
              : this.preferences.selectedMainChatSessionId,
          selectedTradePanelChatSessionId:
            this.preferences === undefined
              ? preferences.selectedTradePanelChatSessionId
              : this.preferences.selectedTradePanelChatSessionId,
          showChatThoughts: this.preferences?.showChatThoughts ?? preferences.showChatThoughts,
        }
        this.preferences = next
        // Never write settings we could not read: that turns a failed load into
        // a lost configuration the moment the trader adjusts anything.
        if (this.preferencesLoaded) this.persistPreferences?.(next)
      },
      onSessionExpired: () => this.showLogin(),
      stops: this.stops,
      alerts: this.alerts,
      sound: this.sound,
      logs: this.logs,
      manageInput: false,
      onMarketOpenChange: (open) => workspace?.setMarketOpen(open),
      onInstrumentsChange: (activeInstruments) => (
        chatViews.forEach((view) => view.setContractInstruments(activeInstruments))
      ),
      chat: tradePanelChat,
    })
    selectContract = (symbol, focusInstrument) => {
      workspace?.selectTab("trade")
      trade.selectContract(symbol, { focusInstrument })
    }
    // Both views stay mounted and observe the same server-owned runs. Only the main
    // view owns global sounds and notifications, so one event has one side effect.
    new ChatClient(stream, {
      onSessions: (sessions) => chatViews.forEach((view) => view.acceptSessions(sessions)),
      onMessage: (sessionId, message) => chatViews.forEach((view) => view.acceptMessage(sessionId, message)),
      onMessageRemoved: (sessionId, messageId) => chatViews.forEach((view) => view.acceptMessageRemoved(sessionId, messageId)),
      onCompaction: (compaction) => chatViews.forEach((view) => view.acceptCompaction(compaction)),
      onDelta: (sessionId, runId, delta) => chatViews.forEach((view) => view.acceptDelta(sessionId, runId, delta)),
      onRun: (sessionId, runId, status, promptMessageId, error) => {
        // Both views consume the run state, but only one should log the same failure.
        mainChat.acceptRun(sessionId, runId, status, promptMessageId, error)
        tradePanelChat.acceptRun(sessionId, runId, status, promptMessageId)
      },
      onQuestionAsked: (request) => chatViews.forEach((view) => view.acceptQuestion(request)),
      onQuestionResolved: (sessionId, requestId) => chatViews.forEach((view) => view.acceptQuestionResolved(sessionId, requestId)),
      onPermissionRequested: (request) => chatViews.forEach((view) => view.acceptPermission(request)),
      onPermissionResolved: (sessionId, requestId) => chatViews.forEach((view) => view.acceptPermissionResolved(sessionId, requestId)),
      onPermissionModeChanged: (state) => chatViews.forEach((view) => view.acceptPermissionMode(state)),
      onNotification: (notification) => chatViews.forEach((view) => view.acceptNotification(notification)),
      onNotificationDismissed: (notificationId) => chatViews.forEach((view) => view.acceptNotificationDismissed(notificationId)),
      onResync: (sessionId) => chatViews.forEach((view) => view.resync(sessionId)),
    })
    const logs = new LogsScreen(this.renderer, {
      logs: this.logs,
      onClose: () => workspace?.selectTab("trade"),
    })
    workspace = new TradingWorkspaceScreen(this.renderer, { trade, chat: mainChat, logs, sound: this.sound })
    return workspace
  }

  private createLogin(): LoginScreen {
    return new LoginScreen(this.renderer, this.session.http, {
      credentials: null,
      onAuthenticated: () => void this.openWorkspace(),
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
        (cause: unknown) => this.onNoAnswer(cause),
      )
    }, this.sessionPollMs)
  }

  private onSessionAnswer(authenticated: boolean): void {
    if (this.disposed || this.screen instanceof TradingWorkspaceScreen) return
    if (authenticated) {
      void this.openWorkspace()
      return
    }
    // The server is reachable and holds nothing, so now there is something for
    // the trader to do. A sign-in already on screen is left alone: replacing it
    // would clear a password halfway through being typed.
    if (this.screen instanceof ConnectingScreen) this.replaceScreen(this.createLogin())
  }

  private onNoAnswer(cause: unknown): void {
    if (this.disposed) return
    // A sign-in screen the server asked for stays put — the trader may be part
    // way through it, and the poll keeps running underneath either way.
    if (this.screen instanceof ConnectingScreen) this.screen.reportFailure(errorMessage(cause))
  }

  private stopWatchingForSession(): void {
    if (!this.sessionWatch) return
    clearInterval(this.sessionWatch)
    this.sessionWatch = null
  }

  private handleStreamError(scope: string, cause: unknown): void {
    if (requiresAuthentication(cause)) {
      this.showLogin()
      return
    }
    if (!isTransientError(cause)) this.logs.error(scope, cause)
  }

  /** Only ever called because the server said the session is gone. */
  private showLogin(): void {
    if (this.disposed || this.screen instanceof LoginScreen) return
    this.watchForSession()
    this.replaceScreen(
      new LoginScreen(this.renderer, this.session.http, {
        initialStatus: "Session expired · Sign in",
        credentials: null,
        onAuthenticated: () => void this.openWorkspace(),
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

  private armQuitConfirmation(now: number): void {
    this.resetQuitConfirmation()
    this.quitConfirmationAt = now
    this.screen?.setQuitConfirmation?.(true)
    this.quitConfirmationTimer = setTimeout(() => this.resetQuitConfirmation(), QUIT_CONFIRMATION_MS)
  }

  private resetQuitConfirmation(): void {
    if (this.quitConfirmationAt === null && this.quitConfirmationTimer === null) return
    this.quitConfirmationAt = null
    if (this.quitConfirmationTimer) clearTimeout(this.quitConfirmationTimer)
    this.quitConfirmationTimer = null
    this.screen?.setQuitConfirmation?.(false)
  }

  private copySelection(): boolean {
    return copySelection(this.selection, this.clipboard, (error) => this.logs.error("Clipboard", error))
  }

  get preferencesReady(): boolean {
    return this.preferencesLoaded
  }
}

function exitWithSigint(): void {
  process.kill(process.pid, "SIGINT")
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
