import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  fg,
  link,
  t,
  type KeyEvent,
  type Renderable,
  type RenderContext,
} from "@opentui/core"
import { requiresAuthentication } from "../api/index.ts"
import type { ChatGptAccount } from "../ai/chatgpt-account.ts"
import { AccountPanel } from "../components/account-panel.ts"
import { BrokerageDateModal } from "../components/brokerage-date-modal.ts"
import { BrokeragePanel } from "../components/brokerage-panel.ts"
import { CandlestickChart } from "../components/candlestick-chart.ts"
import { ContractDetailsPanel } from "../components/contract-details-panel.ts"
import { DepthPanel } from "../components/depth-panel.ts"
import { DOUBLE_CLICK_MS, SelectableList } from "../components/selectable-list.ts"
import { isShortcutHelpKey, ShortcutHelp, type ShortcutHelpSection } from "../components/shortcut-help.ts"
import { ProviderAccountModal } from "../components/provider-account-modal.ts"
import {
  WORKSPACE_CHROME_BACKGROUND,
  WORKSPACE_CHROME_MUTED,
  WORKSPACE_CHROME_TEXT,
} from "../components/workspace-chrome.ts"
import type { ApplicationLog } from "../logging/application-log.ts"
import {
  DEFAULT_BROKERAGE_RANGE,
  type BrokerageDatePreset,
  type BrokerageDateRange,
  type BrokerageDistributionSource,
} from "../market/brokerage.ts"
import type { CandleSource } from "../market/candle.ts"
import type { DepthStream } from "../market/depth.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "../market/equity-quote-stream.ts"
import type { ViopInstrument, ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsArticle, NewsSource } from "../market/news.ts"
import type { QuoteStream, QuoteUpdate } from "../market/quote-stream.ts"
import type { MemberFeatureSource } from "../member/features.ts"
import type { AccountSource, AccountStream } from "../trading/account.ts"
import type {
  ViopOrderCancellationSource,
  ViopOrderSide,
  ViopOrderSource,
  ViopPositionExitSource,
} from "../trading/order.ts"
import { ViopOrderTicket } from "./order-ticket.ts"
import {
  DEFAULT_WATCHLIST_PREFERENCES,
  normalizeWatchlistPreferences,
  type InstrumentSort,
  type SortDirection,
  type WatchlistPreferences,
} from "./watchlist-preferences.ts"

const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const NEUTRAL_COLOR = "#999999"
const SIDE_PANEL_BG = "#161616"
const SELECTED_ROW_BG = "#282828"
const HEADER_COLOR = "#dddddd"
const FOCUSED_HEADER = "#ffffff"
const UNFOCUSED_HEADER = "#666666"
const LINK_COLOR = "#6cb6ff"
const NEWS_TIME_COLOR = "#8a8a8a"
const NEWS_HEADLINE_COLOR = "#e0e0e0"

const NEWS_POLL_INTERVAL_MS = 60_000
const INSTRUMENT_POLL_INTERVAL_MS = 60_000
const DESTRUCTIVE_CONFIRMATION_TIMEOUT_MS = 3_000
const COMPACT_LAYOUT_WIDTH = 104
const DEPTH_PANEL_WIDTH = 48
const BROKERAGE_POLL_INTERVAL_MS = 60_000
// Each panel is guaranteed the rows its fixed content needs, then both grow at
// the same rate so whatever the terminal has left over is split evenly.
const DEPTH_PANEL_BASIS = 19
const BROKERAGE_PANEL_BASIS = 8
// The instrument list, depth ladder and news feed together claim 130 fixed
// columns, so the depth panel only joins them permanently once the chart and
// account column can still keep about 60. Below that it takes the news slot
// while it holds focus instead.
const DEPTH_LAYOUT_WIDTH = 190
const SORT_LABELS = { change: "Change", volume: "Volume" } as const
const NEWS_FEEDS = ["instrument", "index"] as const
type NewsFeed = (typeof NEWS_FEEDS)[number]
type DestructiveAction = "cancel-orders" | "exit-positions"
const NEWS_FEED_LABELS: Record<NewsFeed, string> = { instrument: "Stock", index: "Index" }
const WATCHLIST_HINT = "B/S trade · G logs · / ticker · ? help · Ctrl+C quit"
const WATCHLIST_SHORTCUTS: ShortcutHelpSection[] = [
  {
    title: "Global",
    bindings: [
      { keys: "?", description: "Toggle this help" },
      { keys: "A", description: "Open AI provider account" },
      { keys: "G", description: "Open application logs" },
      { keys: "/", description: "Search and switch ticker" },
      { keys: "B / S", description: "Open buy / sell ticket" },
      { keys: "c c", description: "Cancel all pending VIOP orders" },
      { keys: "x x", description: "Exit all VIOP positions" },
      { keys: "Tab", description: "Move focus to the next panel" },
      { keys: "Ctrl+C", description: "Quit" },
    ],
  },
  {
    title: "Ticker search",
    bindings: [
      { keys: "Type", description: "Filter by ticker or contract symbol" },
      { keys: "↑/↓ or Ctrl+p/n", description: "Cycle through matches" },
      { keys: "Enter", description: "Switch to the selected match" },
      { keys: "Backspace", description: "Delete the last character" },
      { keys: "Esc", description: "Cancel search" },
    ],
  },
  {
    title: "VIOP contracts",
    bindings: [
      { keys: "↑/↓ or j/k", description: "Move selection" },
      { keys: "Home / End", description: "Select first / last contract" },
      { keys: "C", description: "Sort by price change" },
      { keys: "V", description: "Sort by volume" },
    ],
  },
  {
    title: "Chart",
    bindings: [
      { keys: "←/→ or h/l", description: "Change range" },
      { keys: "↑/↓ or j/k", description: "Change timeframe" },
      { keys: "Shift+←/→ or H/L", description: "Scroll candle history" },
      { keys: "Shift+Home / End", description: "Jump to oldest / newest candles" },
      { keys: "f", description: "Cycle chart asset" },
    ],
  },
  {
    title: "Depth",
    bindings: [
      { keys: "Tab", description: "Focus the order book of the underlying stock" },
    ],
  },
  {
    title: "Brokers",
    bindings: [
      { keys: "←/→ or h/l", description: "Switch between buyers and sellers" },
      { keys: "↑/↓ or j/k", description: "Scroll beyond the leading houses" },
      { keys: "Home", description: "Back to the top of the list" },
      { keys: "d", description: "Change the date range" },
    ],
  },
  {
    title: "Account",
    bindings: [
      { keys: "←/→ or h/l", description: "Change account tab" },
      { keys: "↑/↓ or j/k", description: "Scroll" },
      { keys: "Home", description: "Scroll to top" },
      { keys: "R", description: "Refresh account" },
    ],
  },
  {
    title: "News",
    bindings: [
      { keys: "←/→ or h/l", description: "Change stock / index feed" },
      { keys: "↑/↓ or j/k", description: "Move selection or scroll article" },
      { keys: "Home / End", description: "Select first / last article" },
      { keys: "Enter", description: "Open selected article" },
      { keys: "Esc / Backspace", description: "Close article" },
    ],
  },
  {
    title: "Order ticket",
    bindings: [
      { keys: "Tab / Shift+Tab", description: "Move between fields" },
      { keys: "↑/↓", description: "Move between fields" },
      { keys: "←/→ or Space", description: "Toggle order type on its field" },
      { keys: "L / M", description: "Select limit / simulated market" },
      { keys: "Digits, . or ,", description: "Enter contracts or limit price" },
      { keys: "Backspace", description: "Delete the last digit" },
      { keys: "R", description: "Review order" },
      { keys: "Enter", description: "Next field, review, or submit" },
      { keys: "B / S", description: "Review or submit the matching side" },
      { keys: "Esc", description: "Return to edit or close ticket" },
    ],
  },
]

export interface WatchlistScreenOptions {
  instruments: ViopInstrumentSource
  candles: CandleSource
  news: NewsSource
  account?: AccountSource
  accountStream?: AccountStream
  orders?: ViopOrderSource
  orderCancellation?: ViopOrderCancellationSource
  positionExit?: ViopPositionExitSource
  equityQuotes?: EquityQuoteStream
  quotes?: QuoteStream
  depth?: DepthStream
  brokerage?: BrokerageDistributionSource
  memberFeatures?: MemberFeatureSource
  onSessionExpired?: () => void
  newsIntervalMs?: number
  instrumentIntervalMs?: number
  accountIntervalMs?: number
  brokerageIntervalMs?: number
  destructiveConfirmationTimeoutMs?: number
  preferences?: WatchlistPreferences
  onPreferencesChange?: (preferences: WatchlistPreferences) => void
  chatGptAccount?: ChatGptAccount
  logs?: ApplicationLog
  manageInput?: boolean
  onOpenLogs?: () => void
}

type Focus = "instruments" | "chart" | "depth" | "brokers" | "account" | "news"

export class WatchlistScreen {
  readonly root: BoxRenderable

  private readonly leftPanel: BoxRenderable
  private readonly centerPanel: BoxRenderable
  private readonly instrumentList: SelectableList
  private readonly contractDetailsPanel: ContractDetailsPanel
  private readonly sortButtons = new Map<InstrumentSort, BoxRenderable>()
  private readonly sortButtonLabels = new Map<InstrumentSort, TextRenderable>()
  private readonly chart: CandlestickChart
  private readonly chartHeader: TextRenderable
  private readonly accountPanel: AccountPanel
  private readonly depthColumn: BoxRenderable
  private readonly depthPanel: DepthPanel
  private readonly brokeragePanel: BrokeragePanel
  private readonly rightPanel: BoxRenderable
  private readonly viopHeader: TextRenderable
  private readonly newsHeader: TextRenderable
  private readonly newsFeedButtons = new Map<NewsFeed, BoxRenderable>()
  private readonly newsFeedButtonLabels = new Map<NewsFeed, TextRenderable>()
  private readonly newsList: SelectableList
  private readonly newsReader: ScrollBoxRenderable
  private readonly newsMessage: TextRenderable
  private readonly hint: TextRenderable
  private orderTicket: ViopOrderTicket | null = null
  private shortcutHelp: ShortcutHelp | null = null
  private providerAccountModal: ProviderAccountModal | null = null
  private tickerSearchQuery: string | null = null
  private tickerSearchMatchIndex = 0
  private pendingDestructiveAction: DestructiveAction | null = null

  private newsContent: Renderable | null = null
  private newsFeed: NewsFeed = "instrument"
  private instruments: ViopInstrument[] = []
  private newsArticles: NewsArticle[] = []
  private readonly symbolIndex = new Map<string, number>()
  private readonly referenceClose = new Map<string, number>()
  private focus: Focus = "instruments"
  private articleOpen = false
  private destroyed = false
  private sessionExpiredNotified = false
  private newsRequestUid: string | null = null
  private articleRequestUid: string | null = null
  private contractDetailsRequest: AbortController | null = null
  private tradingActionRequest: AbortController | null = null
  private readerLastClickAt = 0
  private newsTimer: ReturnType<typeof setInterval> | null = null
  private instrumentTimer: ReturnType<typeof setInterval> | null = null
  private instrumentRefreshRequest: AbortController | null = null
  private memberFeatureRequest: AbortController | null = null
  private depthEntitled: boolean | null = null
  private brokerageEntitled: boolean | null = null
  private brokerageRequest: AbortController | null = null
  private brokerageTimer: ReturnType<typeof setInterval> | null = null
  private brokerageRange: BrokerageDateRange = DEFAULT_BROKERAGE_RANGE
  private brokeragePresets: BrokerageDatePreset[] = []
  private brokerageDates: string[] = []
  private brokerageLive = false
  private brokerageDateModal: BrokerageDateModal | null = null
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private destructiveConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private equityConnected = false
  private selectedEquitySymbol: string | null = null
  private preferences: WatchlistPreferences
  private instrumentSort: InstrumentSort
  private sortDirection: SortDirection

  private readonly handleKeypress = (key: KeyEvent): void => {
    const destructiveAction = destructiveActionForKey(key)
    if (!destructiveAction) this.clearDestructiveConfirmation()
    if (this.tickerSearchQuery !== null) {
      this.handleTickerSearchKey(key)
      return
    }
    if (this.shortcutHelp) {
      this.shortcutHelp.handleKey(key)
      return
    }
    if (this.providerAccountModal) {
      this.providerAccountModal.handleKey(key)
      return
    }
    if (this.brokerageDateModal) {
      this.brokerageDateModal.handleKey(key)
      return
    }
    if (isShortcutHelpKey(key)) {
      this.openShortcutHelp()
      return
    }
    if (this.orderTicket) {
      this.orderTicket.handleKey(key)
      return
    }
    if (this.articleOpen) {
      if (key.name === "escape" || key.name === "esc" || key.name === "backspace") this.closeArticle()
      else if (key.name === "up" || key.name === "k") this.newsReader.scrollBy({ x: 0, y: -2 })
      else if (key.name === "down" || key.name === "j") this.newsReader.scrollBy({ x: 0, y: 2 })
      return
    }
    if (isTickerSearchKey(key)) {
      this.openTickerSearch()
      return
    }
    if (isCapitalShortcut(key, "a")) {
      this.openProviderAccount()
      return
    }
    if (isCapitalShortcut(key, "g")) {
      this.openLogs()
      return
    }
    if (!key.ctrl && (key.name === "b" || key.name === "s")) {
      this.openOrderTicket(key.name === "b" ? "BUY" : "SELL")
      return
    }
    if (destructiveAction) {
      if (this.confirmDestructiveAction(destructiveAction)) {
        if (destructiveAction === "cancel-orders") void this.cancelAllPendingOrders()
        else void this.exitAllPositions()
      }
      return
    }
    if (key.name === "tab") {
      this.toggleFocus()
      return
    }
    // The depth panel is read-only; it swallows keys rather than letting them
    // reach the instrument list behind it.
    if (this.focus === "depth") return
    if (this.focus === "brokers") {
      this.brokeragePanel.handleKey(key)
      return
    }
    if (this.focus === "news") {
      if (!key.ctrl && !key.shift && !key.meta && !key.option && (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l")) {
        const direction = key.name === "left" || key.name === "h" ? -1 : 1
        const current = NEWS_FEEDS.indexOf(this.newsFeed)
        const feed = NEWS_FEEDS[(current + direction + NEWS_FEEDS.length) % NEWS_FEEDS.length]
        if (feed) this.selectNewsFeed(feed)
      } else {
        this.newsList.handleKey(key)
      }
    }
    else if (this.focus === "account") this.accountPanel.handleKey(key)
    else if (this.focus === "chart") this.chart.handleKey(key)
    else if (isCapitalShortcut(key, "c")) this.selectInstrumentSort("change")
    else if (isCapitalShortcut(key, "v")) this.selectInstrumentSort("volume")
    else this.instrumentList.handleKey(key)
  }

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: WatchlistScreenOptions,
  ) {
    this.preferences = normalizeWatchlistPreferences(options.preferences ?? DEFAULT_WATCHLIST_PREFERENCES)
    this.instrumentSort = this.preferences.instrumentSort
    this.sortDirection = this.preferences.sortDirection

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      onSizeChange: () => this.updateResponsiveLayout(),
    })

    const columns = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
    })

    this.leftPanel = new BoxRenderable(renderer, {
      width: 36,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    this.viopHeader = panelHeader(renderer, "VIOP")
    this.leftPanel.add(this.viopHeader)
    const sortToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      gap: 1,
      marginBottom: 1,
    })
    sortToolbar.add(new TextRenderable(renderer, { content: "Sort", fg: NEUTRAL_COLOR, width: 5 }))
    for (const sort of ["change", "volume"] as const) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.setFocus("instruments")
          this.selectInstrumentSort(sort)
        },
      })
      const label = new TextRenderable(renderer, { content: SORT_LABELS[sort] })
      button.add(label)
      sortToolbar.add(button)
      this.sortButtons.set(sort, button)
      this.sortButtonLabels.set(sort, label)
    }
    this.leftPanel.add(sortToolbar)
    this.instrumentList = new SelectableList(renderer, {
      selectedBackgroundColor: SELECTED_ROW_BG,
      backgroundColor: SIDE_PANEL_BG,
      indicatorColor: HEADER_COLOR,
      onSelect: (index) => this.onInstrumentSelected(index),
      onFocusRequest: () => this.setFocus("instruments"),
    })
    this.leftPanel.add(this.instrumentList.root)
    this.contractDetailsPanel = new ContractDetailsPanel(renderer)
    this.leftPanel.add(this.contractDetailsPanel.root)

    this.centerPanel = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
    })
    this.chartHeader = panelHeader(renderer, "Chart")
    this.centerPanel.add(this.chartHeader)
    this.chart = new CandlestickChart(renderer, {
      source: options.candles,
      initialRange: this.preferences.candleRange,
      initialInterval: this.preferences.candleInterval,
      initialTarget: this.preferences.chartTarget,
      onSelectionChange: (candleRange, candleInterval) => {
        this.savePreferences({ candleRange, candleInterval })
      },
      onTargetChange: (chartTarget) => {
        this.savePreferences({ chartTarget })
        this.syncChartQuoteSubscription()
        this.renderChartHeader()
      },
      onFocusRequest: () => this.setFocus("chart"),
      onError: (error) => this.reportError("Chart", error),
    })
    this.centerPanel.add(this.chart.root)
    this.accountPanel = new AccountPanel(renderer, {
      source: options.account,
      stream: options.accountStream,
      refreshIntervalMs: options.accountIntervalMs,
      onFocusRequest: () => this.setFocus("account"),
      onPositionSelect: (position) => this.selectPositionInstrument(position.uid, position.symbol),
      onError: (error) => this.reportError("Account", error),
    })
    this.centerPanel.add(this.accountPanel.root)

    // The order book and the broker distribution share one column: each keeps
    // the rows its fixed content needs and they split the remainder evenly.
    this.depthColumn = new BoxRenderable(renderer, { flexDirection: "column" })
    this.depthPanel = new DepthPanel(renderer, { onFocusRequest: () => this.setFocus("depth") })
    this.depthPanel.setEntitled(options.memberFeatures ? null : false)
    this.depthPanel.root.flexBasis = DEPTH_PANEL_BASIS
    this.depthPanel.root.flexGrow = 1
    this.brokeragePanel = new BrokeragePanel(renderer, {
      onSideChange: () => void this.loadBrokerage(),
      onOpenDateRange: () => this.openBrokerageDateModal(),
      onFocusRequest: () => this.setFocus("brokers"),
    })
    this.brokeragePanel.setEntitled(options.memberFeatures ? null : false)
    this.brokeragePanel.root.flexBasis = BROKERAGE_PANEL_BASIS
    this.brokeragePanel.root.flexGrow = 1
    this.depthColumn.add(this.depthPanel.root)
    this.depthColumn.add(this.brokeragePanel.root)

    this.rightPanel = new BoxRenderable(renderer, {
      width: 46,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    this.newsHeader = panelHeader(renderer, "News")
    this.rightPanel.add(this.newsHeader)
    const newsFeedToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      gap: 1,
      marginBottom: 1,
    })
    newsFeedToolbar.add(new TextRenderable(renderer, { content: "Feed", fg: NEUTRAL_COLOR, width: 5 }))
    for (const feed of NEWS_FEEDS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.setFocus("news")
          this.selectNewsFeed(feed)
        },
      })
      const label = new TextRenderable(renderer, { content: NEWS_FEED_LABELS[feed] })
      button.add(label)
      newsFeedToolbar.add(button)
      this.newsFeedButtons.set(feed, button)
      this.newsFeedButtonLabels.set(feed, label)
    }
    this.rightPanel.add(newsFeedToolbar)
    this.newsList = new SelectableList(renderer, {
      selectedBackgroundColor: SELECTED_ROW_BG,
      backgroundColor: SIDE_PANEL_BG,
      indicatorColor: HEADER_COLOR,
      wrapContent: true,
      rowGap: 1,
      onActivate: (index) => void this.openArticle(index),
      onFocusRequest: () => this.setFocus("news"),
    })
    this.newsReader = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: SIDE_PANEL_BG,
      contentOptions: { flexDirection: "column", gap: 1, paddingRight: 2, backgroundColor: SIDE_PANEL_BG },
      onMouseDown: (event) => {
        if (event.button !== 0 || !this.articleOpen) return
        const now = Date.now()
        if (now - this.readerLastClickAt < DOUBLE_CLICK_MS) {
          this.readerLastClickAt = 0
          this.closeArticle()
        } else {
          this.readerLastClickAt = now
        }
      },
    })
    this.newsMessage = new TextRenderable(renderer, { content: "Loading news…", fg: "#777777" })
    this.setNewsContent(this.newsMessage)

    columns.add(this.leftPanel)
    columns.add(this.centerPanel)
    columns.add(this.depthColumn)
    columns.add(this.rightPanel)

    this.hint = new TextRenderable(renderer, {
      content: WATCHLIST_HINT,
      fg: WORKSPACE_CHROME_MUTED,
      width: "100%",
    })
    const footer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: WORKSPACE_CHROME_BACKGROUND,
    })
    footer.add(this.hint)

    this.root.add(columns)
    this.root.add(footer)

    this.options.quotes?.subscribe((update) => this.onQuote(update))
    this.options.quotes?.onConnectionChange((connected) => this.setConnected(connected))
    this.options.equityQuotes?.subscribe((update) => this.onEquityQuote(update))
    this.options.equityQuotes?.onConnectionChange((connected) => this.setEquityConnected(connected))
    this.options.depth?.subscribe((book) => this.depthPanel.showBook(book))
    this.options.depth?.onStatusChange((status) => this.depthPanel.setStatus(status))
  }

  mount(): void {
    if (this.options.manageInput !== false) this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.updateFocusIndicator()
    this.accountPanel.mount()
    void this.load()
    void this.loadMemberFeatures()
    this.newsTimer = setInterval(() => void this.refreshNews(), this.options.newsIntervalMs ?? NEWS_POLL_INTERVAL_MS)
    this.instrumentTimer = setInterval(
      () => void this.refreshInstruments(),
      this.options.instrumentIntervalMs ?? INSTRUMENT_POLL_INTERVAL_MS,
    )
    // A historical range is settled, so only a range covering the open session
    // is worth re-reading.
    this.brokerageTimer = setInterval(() => {
      if (this.brokerageLive) void this.loadBrokerage(true)
    }, this.options.brokerageIntervalMs ?? BROKERAGE_POLL_INTERVAL_MS)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.chart.destroy()
    this.accountPanel.destroy()
    this.tickerSearchQuery = null
    this.closeShortcutHelp()
    this.closeProviderAccount()
    this.closeOrderTicket()
    this.contractDetailsRequest?.abort()
    this.contractDetailsRequest = null
    this.tradingActionRequest?.abort()
    this.tradingActionRequest = null
    this.instrumentRefreshRequest?.abort()
    this.instrumentRefreshRequest = null
    this.options.quotes?.stop()
    this.options.equityQuotes?.stop()
    this.options.depth?.stop()
    this.memberFeatureRequest?.abort()
    this.memberFeatureRequest = null
    this.brokerageRequest?.abort()
    this.brokerageRequest = null
    this.closeBrokerageDateModal()
    if (this.brokerageTimer) {
      clearInterval(this.brokerageTimer)
      this.brokerageTimer = null
    }
    if (this.newsTimer) {
      clearInterval(this.newsTimer)
      this.newsTimer = null
    }
    if (this.instrumentTimer) {
      clearInterval(this.instrumentTimer)
      this.instrumentTimer = null
    }
    if (this.hintTimer) {
      clearTimeout(this.hintTimer)
      this.hintTimer = null
    }
    if (this.destructiveConfirmationTimer) {
      clearTimeout(this.destructiveConfirmationTimer)
      this.destructiveConfirmationTimer = null
    }
    if (this.options.manageInput !== false) this.renderer.keyInput.off("keypress", this.handleKeypress)
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  handleKey(key: KeyEvent): void {
    this.handleKeypress(key)
  }

  private async load(): Promise<void> {
    try {
      const instruments = await this.options.instruments.listInstruments()
      if (this.destroyed) return
      this.instruments = instruments
      this.referenceClose.clear()
      instruments.forEach((instrument) => {
        const reference = referenceClose(instrument)
        if (reference !== null) this.referenceClose.set(instrument.symbol, reference)
      })
      this.sortAndRenderInstrumentList(this.preferences.selectedInstrumentUid ?? undefined)
      if (instruments.length > 0) {
        this.onInstrumentSelected(this.instrumentList.selectedIndex)
        this.options.quotes?.start(instruments.map((instrument) => instrument.symbol))
      } else {
        this.chartHeader.content = "Chart  ·  No VIOP instruments"
      }
    } catch (error) {
      if (this.destroyed) return
      if (this.reportError("Watchlist", error)) return
      this.chartHeader.content = "Chart  ·  Failed to load instruments · See Logs"
      this.chartHeader.fg = "#ff6b6b"
    }
  }

  // Market depth is a paid feature, so the panel stays locked until the member's
  // entitlements come back. A failed check is treated as "not entitled" rather
  // than retried: opening the stream without it only earns an HTTP 403.
  private async loadMemberFeatures(): Promise<void> {
    const source = this.options.memberFeatures
    if (!source) return
    const request = new AbortController()
    this.memberFeatureRequest = request
    try {
      const features = await source.loadFeatures({ signal: request.signal })
      if (this.destroyed || request.signal.aborted) return
      this.setDepthEntitled(features.has("MARKET_DEPTH"))
      this.setBrokerageEntitled(features.has("BROKERAGE_DISTRIBUTION"))
    } catch (error) {
      if (this.destroyed || request.signal.aborted || isAbortError(error)) return
      this.reportError("Member features", error)
      this.setDepthEntitled(false)
      this.setBrokerageEntitled(false)
    } finally {
      if (this.memberFeatureRequest === request) this.memberFeatureRequest = null
    }
  }

  // Reads the ranked broker houses for the selected contract's underlying. The
  // figures keep moving while the range covers the open session, so a poll
  // refreshes them in the background and leaves the last good table on screen
  // when a refresh fails.
  private async loadBrokerage(background = false): Promise<void> {
    const source = this.options.brokerage
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!source || !instrument || !this.brokerageEntitled || this.destroyed) return
    this.brokerageRequest?.abort()
    const request = new AbortController()
    this.brokerageRequest = request
    const side = this.brokeragePanel.activeSide
    try {
      const distribution = await source.loadDistribution({
        instrumentUid: instrument.uid,
        side,
        range: this.brokerageRange,
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.brokerageRequest !== request) return
      this.brokeragePresets = distribution.presets
      this.brokerageDates = distribution.availableDates
      this.brokerageLive = distribution.live
      this.brokeragePanel.showDistribution(distribution)
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.brokerageRequest !== request || isAbortError(error)) return
      if (this.reportError("Broker distribution", error)) return
      if (!background) this.brokeragePanel.showMessage(`Failed to load: ${errorMessage(error)}`, "#ff6b6b")
    } finally {
      if (this.brokerageRequest === request) this.brokerageRequest = null
    }
  }

  private openBrokerageDateModal(): void {
    if (this.destroyed || this.brokerageDateModal) return
    if (this.brokerageDates.length === 0 && this.brokeragePresets.length === 0) {
      this.showHintStatus("Broker distribution has not loaded yet.", "#e5c07b", 3_000)
      return
    }
    const modal = new BrokerageDateModal(this.renderer, {
      presets: this.brokeragePresets,
      availableDates: this.brokerageDates,
      range: this.brokerageRange,
      onSelect: (range) => {
        this.closeBrokerageDateModal()
        this.selectBrokerageRange(range)
      },
      onClose: () => this.closeBrokerageDateModal(),
    })
    this.brokerageDateModal = modal
    this.root.add(modal.root)
    this.renderer.requestRender()
  }

  private closeBrokerageDateModal(): void {
    const modal = this.brokerageDateModal
    if (!modal) return
    this.brokerageDateModal = null
    if (!this.root.isDestroyed && !modal.root.isDestroyed) this.root.remove(modal.root)
    modal.destroy()
    this.renderer.requestRender()
  }

  private selectBrokerageRange(range: BrokerageDateRange): void {
    this.brokerageRange = range
    this.brokeragePanel.setRange(range)
    this.brokeragePanel.reset()
    void this.loadBrokerage()
  }

  private setBrokerageEntitled(entitled: boolean): void {
    if (this.brokerageEntitled === entitled) return
    this.brokerageEntitled = entitled
    this.brokeragePanel.setEntitled(entitled)
    if (entitled) void this.loadBrokerage()
  }

  private setDepthEntitled(entitled: boolean): void {
    if (this.depthEntitled === entitled) return
    this.depthEntitled = entitled
    this.depthPanel.setEntitled(entitled)
    this.syncDepthSubscription()
  }

  // The depth book belongs to the underlying stock; VIOP contract symbols have
  // none of their own, so the panel always follows the underlying.
  private syncDepthSubscription(): void {
    const depth = this.options.depth
    if (!depth) return
    const symbol = this.depthEntitled ? this.selectedEquitySymbol : null
    if (symbol) depth.start(symbol)
    else depth.stop()
  }

  // Applies a live price tick in place. The stream carries only the traded
  // price, so the daily change is re-derived against the session's reference
  // close, which the snapshot poll keeps current across trading days.
  private onQuote(update: QuoteUpdate): void {
    if (this.destroyed) return
    this.accountPanel.applyQuote(update)
    const index = this.symbolIndex.get(update.symbol)
    if (index === undefined) return
    const instrument = this.instruments[index]
    if (!instrument) return

    if (update.lastPrice !== null) instrument.lastPrice = update.lastPrice
    if (
      this.preferences.chartTarget === "INSTRUMENT"
      && this.instruments[this.instrumentList.selectedIndex]?.uid === instrument.uid
      && update.lastPrice !== null
    ) {
      this.chart.updateLastPrice(instrument.uid, update.lastPrice, update.timestamp)
    }
    if (update.lastPrice !== null) this.contractDetailsPanel.applyPrice(update.symbol, update.lastPrice)
    if (this.orderTicket && this.instruments[this.instrumentList.selectedIndex]?.symbol === update.symbol) {
      this.orderTicket.applyQuote({ lastPrice: update.lastPrice, ask: update.ask, bid: update.bid })
    }
    this.applyReferenceClose(instrument, this.referenceClose.get(update.symbol) ?? null)
    this.renderInstrumentRow(instrument, index)
  }

  // Re-reads the screener snapshot for fresh volumes and, just as importantly, a
  // fresh daily-change reference. The provider rolls that reference over at each
  // settlement, so a session left running across trading days keeps reporting
  // the previous day's change unless the reference is re-derived here.
  private async refreshInstruments(): Promise<void> {
    if (this.destroyed || this.instruments.length === 0 || this.instrumentRefreshRequest) return
    const request = new AbortController()
    this.instrumentRefreshRequest = request
    try {
      const refreshed = await this.options.instruments.listInstruments({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.instrumentRefreshRequest !== request) return
      const snapshots = new Map(refreshed.map((instrument) => [instrument.symbol, instrument]))
      let changed = false
      for (const instrument of this.instruments) {
        const snapshot = snapshots.get(instrument.symbol)
        if (!snapshot) continue
        if (instrument.volume !== snapshot.volume) {
          instrument.volume = snapshot.volume
          changed = true
        }
        // Live ticks own the price; the snapshot only fills symbols yet to tick.
        if (instrument.lastPrice === null && snapshot.lastPrice !== null) {
          instrument.lastPrice = snapshot.lastPrice
          changed = true
        }
        if (this.applyReferenceClose(instrument, referenceClose(snapshot))) changed = true
      }
      if (changed) {
        const selectedUid = this.instruments[this.instrumentList.selectedIndex]?.uid
        this.sortAndRenderInstrumentList(selectedUid, true)
      }
      const selected = this.instruments[this.instrumentList.selectedIndex]
      if (selected) void this.loadContractDetails(selected, true)
    } catch (error) {
      if (!this.destroyed && !request.signal.aborted && !isAbortError(error)) this.reportError("Watchlist refresh", error)
    } finally {
      if (this.instrumentRefreshRequest === request) this.instrumentRefreshRequest = null
    }
  }

  // Stores the session reference for a symbol and re-derives its daily change
  // from the current price. Returns whether the displayed change moved.
  private applyReferenceClose(instrument: ViopInstrument, reference: number | null): boolean {
    if (reference === null || reference <= 0) return false
    this.referenceClose.set(instrument.symbol, reference)
    if (instrument.lastPrice === null) return false
    const changePercent = (instrument.lastPrice / reference - 1) * 100
    if (instrument.changePercent === changePercent) return false
    instrument.changePercent = changePercent
    return true
  }

  // Repaints a single row, re-sorting instead when the list is ordered by change
  // because the row's new value can move it.
  private renderInstrumentRow(instrument: ViopInstrument, index: number): void {
    if (this.instrumentSort === "change") {
      const selectedUid = this.instruments[this.instrumentList.selectedIndex]?.uid
      this.sortAndRenderInstrumentList(selectedUid, true)
      return
    }
    this.instrumentList.updateRow(index, {
      content: formatInstrumentRow(instrument),
      color: changeColor(instrument.changePercent),
    })
  }

  private onEquityQuote(update: EquityQuoteUpdate): void {
    if (this.destroyed || update.symbol !== this.activeEquityQuoteSymbol()) return
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!instrument) return
    this.chart.updateLastPrice(instrument.uid, update.lastPrice, update.timestamp)
  }

  private activeEquityQuoteSymbol(): string | null {
    if (this.preferences.chartTarget === "BIST_100") return "XU100"
    if (this.preferences.chartTarget === "BIST_30") return "XU030"
    if (this.preferences.chartTarget === "UNDERLYING") return this.selectedEquitySymbol
    return null
  }

  private syncChartQuoteSubscription(): void {
    const symbol = this.activeEquityQuoteSymbol()
    this.setEquityConnected(false)
    if (symbol) this.options.equityQuotes?.start(symbol)
    else this.options.equityQuotes?.stop()
  }

  private async refreshNews(): Promise<void> {
    if (this.destroyed || this.articleOpen) return
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!instrument) return
    const feed = this.newsFeed
    const requestKey = feed === "index" ? "INDEX" : instrument.uid
    try {
      const articles = await this.options.news.listNews(feed === "index" ? {} : { instrumentUid: instrument.uid })
      if (this.destroyed || this.articleOpen) return
      if (this.newsFeed !== feed) return
      if (feed === "instrument" && this.instruments[this.instrumentList.selectedIndex]?.uid !== requestKey) return
      if (newsListChanged(this.newsArticles, articles)) {
        this.renderNews(articles, feed === "index" ? "BIST indices" : instrument.displayName)
      }
    } catch (error) {
      if (!this.destroyed) this.reportError("News refresh", error)
    }
  }

  private onInstrumentSelected(index: number): void {
    const instrument = this.instruments[index]
    if (!instrument) return
    if (this.preferences.selectedInstrumentUid !== instrument.uid) {
      this.savePreferences({ selectedInstrumentUid: instrument.uid })
    }
    this.contractDetailsPanel.selectInstrument(instrument, Boolean(this.options.instruments.loadContractDetails))
    void this.loadContractDetails(instrument)
    this.chart.setInstrument(instrument)
    this.selectedEquitySymbol = instrument.underlyingSymbol
    this.syncChartQuoteSubscription()
    this.depthPanel.selectInstrument({
      displayName: instrument.displayName,
      underlyingSymbol: instrument.underlyingSymbol,
    })
    this.syncDepthSubscription()
    this.brokeragePanel.reset()
    void this.loadBrokerage()
    this.renderChartHeader()
    void this.loadNews(instrument)
  }

  private selectPositionInstrument(instrumentUid: string, symbol: string): void {
    const index = this.instruments.findIndex(
      (instrument) => instrument.uid === instrumentUid || instrument.symbol === symbol,
    )
    if (index < 0) {
      this.showHintStatus(`Position contract ${symbol} is not in the watchlist.`, "#e5c07b", 4_000)
      return
    }
    this.setFocus("instruments")
    this.instrumentList.selectIndex(index)
  }

  // Loads the contract stats behind the details panel. Session high/low, volume,
  // open interest and the settlement prices only arrive with this call, so a
  // background reload keeps them current while the selection stays put; it also
  // leaves the last good values on screen when a poll fails.
  private async loadContractDetails(instrument: ViopInstrument, background = false): Promise<void> {
    const source = this.options.instruments
    if (!source.loadContractDetails) return
    this.contractDetailsRequest?.abort()
    const request = new AbortController()
    this.contractDetailsRequest = request
    try {
      const details = await source.loadContractDetails(instrument.uid, { signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.contractDetailsRequest !== request) return
      this.contractDetailsPanel.showDetails(instrument.uid, details)
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.contractDetailsRequest !== request || isAbortError(error)) return
      if (this.reportError("Contract details", error)) return
      if (!background) this.contractDetailsPanel.showError(instrument.uid)
    }
  }

  private async loadNews(instrument: ViopInstrument): Promise<void> {
    const feed = this.newsFeed
    const requestKey = feed === "index" ? "INDEX" : instrument.uid
    this.newsRequestUid = requestKey
    this.articleOpen = false
    this.setMessage("Loading news…", "#777777")
    try {
      const articles = await this.options.news.listNews(feed === "index" ? {} : { instrumentUid: instrument.uid })
      if (this.destroyed || this.newsFeed !== feed || this.newsRequestUid !== requestKey) return
      this.renderNews(articles, feed === "index" ? "BIST indices" : instrument.displayName)
    } catch (error) {
      if (this.destroyed || this.newsFeed !== feed || this.newsRequestUid !== requestKey) return
      if (this.reportError("News", error)) return
      this.setMessage(`Failed to load news: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private selectNewsFeed(feed: NewsFeed): void {
    if (this.newsFeed === feed) return
    this.newsFeed = feed
    this.paintNewsFeedToolbar()
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (instrument) void this.loadNews(instrument)
  }

  private openOrderTicket(side: ViopOrderSide): void {
    const source = this.options.orders
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!source || !instrument || this.orderTicket) return
    const ticket = new ViopOrderTicket(this.renderer, {
      source,
      instrument,
      side,
      initialKind: this.preferences.orderKind,
      onClose: () => this.closeOrderTicket(),
      onKindChange: (orderKind) => this.savePreferences({ orderKind }),
      onPlaced: () => void this.accountPanel.refresh(),
      onError: (error) => this.reportError("Order ticket", error),
    })
    this.orderTicket = ticket
    this.root.add(ticket.root)
    ticket.mount()
  }

  private openShortcutHelp(): void {
    if (this.shortcutHelp || this.destroyed) return
    const help = new ShortcutHelp(this.renderer, {
      sections: WATCHLIST_SHORTCUTS,
      onClose: () => this.closeShortcutHelp(),
    })
    this.shortcutHelp = help
    this.root.add(help.root)
    this.renderer.requestRender()
  }

  private openProviderAccount(): void {
    const account = this.options.chatGptAccount
    if (!account || this.providerAccountModal || this.destroyed) return
    const modal = new ProviderAccountModal(this.renderer, {
      account,
      onClose: () => this.closeProviderAccount(),
    })
    this.providerAccountModal = modal
    this.root.add(modal.root)
    modal.mount()
    this.renderer.requestRender()
  }

  private closeProviderAccount(): void {
    const modal = this.providerAccountModal
    if (!modal) return
    this.providerAccountModal = null
    if (!this.root.isDestroyed && !modal.root.isDestroyed) this.root.remove(modal.root)
    modal.destroy()
    this.renderer.requestRender()
  }

  private openLogs(): void {
    if (this.destroyed) return
    this.options.onOpenLogs?.()
  }

  private openTickerSearch(): void {
    if (this.destroyed || this.tickerSearchQuery !== null) return
    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = null
    this.tickerSearchQuery = ""
    this.tickerSearchMatchIndex = 0
    this.renderTickerSearch()
  }

  private closeTickerSearch(): void {
    if (this.tickerSearchQuery === null) return
    this.tickerSearchQuery = null
    this.tickerSearchMatchIndex = 0
    this.hint.content = WATCHLIST_HINT
    this.hint.fg = WORKSPACE_CHROME_MUTED
  }

  private handleTickerSearchKey(key: KeyEvent): void {
    if (key.name === "escape" || key.name === "esc") {
      this.closeTickerSearch()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      this.selectTickerSearchMatch()
      return
    }
    if (key.name === "backspace") {
      this.tickerSearchQuery = Array.from(this.tickerSearchQuery ?? "").slice(0, -1).join("")
      this.tickerSearchMatchIndex = 0
      this.renderTickerSearch()
      return
    }
    const direction = key.name === "up" || (key.ctrl && key.name === "p")
      ? -1
      : key.name === "down" || (key.ctrl && key.name === "n")
        ? 1
        : 0
    if (direction !== 0) {
      const matches = this.tickerSearchMatches()
      if (matches.length > 0) {
        this.tickerSearchMatchIndex = (this.tickerSearchMatchIndex + direction + matches.length) % matches.length
        this.renderTickerSearch()
      }
      return
    }
    const character = tickerSearchCharacter(key)
    if (character === null) return
    this.tickerSearchQuery = `${this.tickerSearchQuery ?? ""}${character}`
    this.tickerSearchMatchIndex = 0
    this.renderTickerSearch()
  }

  private selectTickerSearchMatch(): void {
    const match = this.tickerSearchMatches()[this.tickerSearchMatchIndex]
    if (!match) return
    const index = this.instruments.findIndex((instrument) => instrument.uid === match.uid)
    if (index < 0) return
    this.closeTickerSearch()
    this.setFocus("instruments")
    this.instrumentList.selectIndex(index)
  }

  private tickerSearchMatches(): ViopInstrument[] {
    const query = normalizedTickerSearch(this.tickerSearchQuery ?? "")
    if (!query) return []
    return this.instruments
      .map((instrument, index) => ({ instrument, index, score: tickerSearchScore(instrument, query) }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.index - right.index)
      .map((entry) => entry.instrument)
  }

  private renderTickerSearch(): void {
    const query = this.tickerSearchQuery ?? ""
    const matches = this.tickerSearchMatches()
    if (this.tickerSearchMatchIndex >= matches.length) this.tickerSearchMatchIndex = 0
    const match = matches[this.tickerSearchMatchIndex]
    const result = !query
      ? "type a ticker"
      : match
        ? `${match.displayName} · ${match.symbol}  ${this.tickerSearchMatchIndex + 1}/${matches.length}`
        : "no matches"
    this.hint.content = t`${fg(WORKSPACE_CHROME_TEXT)(`/${query}`)}  ${fg(match ? WORKSPACE_CHROME_TEXT : WORKSPACE_CHROME_MUTED)(result)}  ${fg(WORKSPACE_CHROME_MUTED)("Enter select · Esc cancel")}`
    this.hint.fg = WORKSPACE_CHROME_TEXT
  }

  private closeShortcutHelp(): void {
    const help = this.shortcutHelp
    if (!help) return
    this.shortcutHelp = null
    if (!this.root.isDestroyed && !help.root.isDestroyed) this.root.remove(help.root)
    help.destroy()
    this.renderer.requestRender()
  }

  private closeOrderTicket(): void {
    const ticket = this.orderTicket
    if (!ticket) return
    this.orderTicket = null
    if (!this.root.isDestroyed && !ticket.root.isDestroyed) this.root.remove(ticket.root)
    ticket.destroy()
    this.renderer.requestRender()
  }

  private confirmDestructiveAction(action: DestructiveAction): boolean {
    if (this.pendingDestructiveAction === action) {
      this.clearDestructiveConfirmation()
      return true
    }
    this.clearDestructiveConfirmation()
    this.pendingDestructiveAction = action
    const key = action === "cancel-orders" ? "c" : "x"
    const description = action === "cancel-orders" ? "cancel all pending orders" : "exit all open positions"
    this.showHintStatus(`Press ${key} again to ${description}.`, "#e5c07b")
    this.destructiveConfirmationTimer = setTimeout(() => {
      if (this.pendingDestructiveAction !== action || this.destroyed) return
      this.clearDestructiveConfirmation()
    }, this.options.destructiveConfirmationTimeoutMs ?? DESTRUCTIVE_CONFIRMATION_TIMEOUT_MS)
    return false
  }

  private clearDestructiveConfirmation(): void {
    if (this.destructiveConfirmationTimer) {
      clearTimeout(this.destructiveConfirmationTimer)
      this.destructiveConfirmationTimer = null
    }
    if (!this.pendingDestructiveAction) return
    this.pendingDestructiveAction = null
    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = null
    this.hint.content = WATCHLIST_HINT
    this.hint.fg = WORKSPACE_CHROME_MUTED
    this.renderer.requestRender()
  }

  private async cancelAllPendingOrders(): Promise<void> {
    const source = this.options.orderCancellation
    if (!source || this.tradingActionRequest || this.destroyed) return
    const request = new AbortController()
    this.tradingActionRequest = request
    this.showHintStatus("Loading pending VIOP orders…", "#e5c07b")
    try {
      const orders = await source.listPendingOrders({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (orders.length === 0) {
        this.showHintStatus("No pending VIOP orders to cancel.", "#888888", 3_000)
        return
      }
      this.showHintStatus(`Cancelling ${orders.length} pending VIOP order${orders.length === 1 ? "" : "s"}…`, "#e5c07b")
      const result = await source.cancelPendingOrders({
        orderUids: orders.map((order) => order.uid),
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (result.cancelledOrderUids.length > 0) void this.accountPanel.refresh()
      if (result.failures.length === 0) {
        const count = result.cancelledOrderUids.length
        this.showHintStatus(`Cancelled ${count} pending VIOP order${count === 1 ? "" : "s"}.`, "#70d7a1", 4_000)
      } else {
        const message = result.failures[0]?.message ?? "Cancellation failed"
        this.showHintStatus(
          `Cancelled ${result.cancelledOrderUids.length}; ${result.failures.length} failed: ${message}`,
          "#ff6b6b",
          6_000,
        )
      }
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request || isAbortError(error)) return
      if (this.reportError("Order cancellation", error)) return
      this.showHintStatus(`Failed to cancel pending orders: ${errorMessage(error)}`, "#ff6b6b", 6_000)
    } finally {
      if (this.tradingActionRequest === request) this.tradingActionRequest = null
    }
  }

  private async exitAllPositions(): Promise<void> {
    const source = this.options.positionExit
    if (!source || this.tradingActionRequest || this.destroyed) return
    const request = new AbortController()
    this.tradingActionRequest = request
    this.showHintStatus("Submitting simulated-market VIOP exits…", "#e5c07b")
    try {
      const result = await source.exitAllPositions({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (result.submitted.length > 0) void this.accountPanel.refresh()
      if (result.submitted.length === 0 && result.failures.length === 0) {
        this.showHintStatus("No open VIOP positions to exit.", "#888888", 3_000)
      } else if (result.failures.length === 0) {
        const count = result.submitted.length
        this.showHintStatus(`Submitted exit orders for ${count} VIOP position${count === 1 ? "" : "s"}.`, "#70d7a1", 4_000)
      } else {
        const message = result.failures[0]?.message ?? "Position exit failed"
        this.showHintStatus(
          `Submitted ${result.submitted.length} exits; ${result.failures.length} failed: ${message}`,
          "#ff6b6b",
          6_000,
        )
      }
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request || isAbortError(error)) return
      if (this.reportError("Position exit", error)) return
      this.showHintStatus(`Failed to exit positions: ${errorMessage(error)}`, "#ff6b6b", 6_000)
    } finally {
      if (this.tradingActionRequest === request) this.tradingActionRequest = null
    }
  }

  private showHintStatus(content: string, color: string, resetAfterMs?: number): void {
    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = null
    this.hint.content = content
    this.hint.fg = color
    if (resetAfterMs === undefined) return
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null
      if (this.destroyed) return
      this.hint.content = WATCHLIST_HINT
      this.hint.fg = WORKSPACE_CHROME_MUTED
    }, resetAfterMs)
  }

  private renderNews(articles: NewsArticle[], label: string): void {
    this.newsArticles = articles
    if (articles.length === 0) {
      this.setMessage(`No recent news for ${label}.`, "#777777")
      return
    }
    this.newsList.setRows(articles.map((article) => ({ id: article.uid, content: newsRowContent(article) })))
    this.setNewsContent(this.newsList.root)
  }

  private async openArticle(index: number): Promise<void> {
    const article = this.newsArticles[index]
    if (!article) return
    this.articleOpen = true
    this.articleRequestUid = article.uid
    this.renderReaderMessage("Loading article…", "#777777")
    this.setNewsContent(this.newsReader)
    try {
      const full = await this.options.news.getArticle(article.uid)
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      this.renderReader(full ?? article)
    } catch (error) {
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      if (this.reportError("News article", error)) return
      this.renderReaderMessage(`Failed to load article: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private notifyIfSessionExpired(error: unknown): boolean {
    if (!requiresAuthentication(error)) return false
    if (!this.sessionExpiredNotified) {
      this.sessionExpiredNotified = true
      this.options.onSessionExpired?.()
    }
    return true
  }

  private reportError(scope: string, error: unknown): boolean {
    this.options.logs?.error(scope, error)
    return this.notifyIfSessionExpired(error)
  }

  private closeArticle(): void {
    this.articleOpen = false
    this.articleRequestUid = null
    this.setNewsContent(this.newsList.root)
  }

  private renderReader(article: NewsArticle): void {
    for (const child of this.newsReader.getChildren()) this.newsReader.remove(child)
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.headline, fg: "#ffffff", wrapMode: "word", width: "100%" }))
    if (article.tag) this.newsReader.add(new TextRenderable(this.renderer, { content: article.tag, fg: "#888888" }))
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.body || "(No content)", fg: "#cccccc", wrapMode: "word", width: "100%" }))

    const links = [article.url, ...article.attachments].filter((url): url is string => Boolean(url))
    if (links.length > 0) {
      this.newsReader.add(new TextRenderable(this.renderer, { content: "Bağlantı:", fg: "#888888" }))
      for (const url of links) {
        this.newsReader.add(
          new TextRenderable(this.renderer, { content: t`${fg(LINK_COLOR)(link(url)(url))}`, wrapMode: "word", width: "100%" }),
        )
      }
    }
    this.newsReader.scrollTo({ x: 0, y: 0 })
  }

  private renderReaderMessage(content: string, fg: string): void {
    for (const child of this.newsReader.getChildren()) this.newsReader.remove(child)
    this.newsReader.add(new TextRenderable(this.renderer, { content, fg }))
  }

  private setMessage(content: string, fg: string): void {
    this.newsMessage.content = content
    this.newsMessage.fg = fg
    this.setNewsContent(this.newsMessage)
  }

  private setNewsContent(node: Renderable): void {
    if (this.newsContent === node) return
    if (this.newsContent && !this.newsContent.isDestroyed) this.rightPanel.remove(this.newsContent)
    this.newsContent = node
    this.rightPanel.add(node)
  }

  private toggleFocus(): void {
    const order: Focus[] = ["instruments", "chart", "depth", "brokers", "account", "news"]
    const index = order.indexOf(this.focus)
    this.setFocus(order[(index + 1) % order.length] ?? "instruments")
  }

  private setFocus(focus: Focus): void {
    if (this.focus === focus) return
    this.focus = focus
    this.updateFocusIndicator()
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    this.renderViopHeader()
    if (this.preferences.chartTarget === "INSTRUMENT") this.renderChartHeader()
  }

  private updateFocusIndicator(): void {
    this.renderViopHeader()
    this.paintSortToolbar()
    this.renderChartHeader()
    this.chart.setFocused(this.focus === "chart")
    this.depthPanel.setFocused(this.focus === "depth")
    this.brokeragePanel.setFocused(this.focus === "brokers")
    this.accountPanel.setFocused(this.focus === "account")
    this.newsHeader.fg = this.focus === "news" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    this.paintNewsFeedToolbar()
    this.updateResponsiveLayout()
  }

  private paintNewsFeedToolbar(): void {
    for (const feed of NEWS_FEEDS) {
      const selected = this.newsFeed === feed
      const button = this.newsFeedButtons.get(feed)
      const label = this.newsFeedButtonLabels.get(feed)
      if (!button || !label) continue
      button.backgroundColor = selected ? SELECTED_ROW_BG : undefined
      label.fg = selected ? "#ffffff" : this.focus === "news" ? "#aaaaaa" : "#666666"
    }
  }

  private setEquityConnected(connected: boolean): void {
    if (this.equityConnected === connected) return
    this.equityConnected = connected
    this.renderChartHeader()
  }

  private renderChartHeader(): void {
    const titleColor = this.focus === "chart" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    if (this.preferences.chartTarget === "BIST_100" || this.preferences.chartTarget === "BIST_30") {
      const index = this.preferences.chartTarget === "BIST_100" ? "XU100" : "XU030"
      const live = this.equityConnected
      const statusColor = live ? UP_COLOR : NEUTRAL_COLOR
      const status = live ? "● live" : "○ snapshot"
      this.chartHeader.content = t`${fg(titleColor)("Chart")}  ${fg(HEADER_COLOR)(`${index} index`)}  ${fg(statusColor)(status)}`
      return
    }
    if (!this.selectedEquitySymbol) {
      this.chartHeader.content = t`${fg(titleColor)("Chart")}`
      return
    }
    const futures = this.preferences.chartTarget === "INSTRUMENT"
    const live = futures ? this.connected : this.equityConnected
    const statusColor = live ? UP_COLOR : NEUTRAL_COLOR
    const status = live ? "● live" : "○ snapshot"
    const asset = futures ? "futures" : "stock"
    this.chartHeader.content = t`${fg(titleColor)("Chart")}  ${fg(HEADER_COLOR)(`${this.selectedEquitySymbol} ${asset}`)}  ${fg(statusColor)(status)}`
  }

  // Three widths: wide terminals carry every column at once; medium ones drop
  // the depth ladder unless it holds focus; narrow ones show the instrument list
  // beside whichever single panel is focused.
  private updateResponsiveLayout(): void {
    const compact = this.root.width < COMPACT_LAYOUT_WIDTH
    const wide = this.root.width >= DEPTH_LAYOUT_WIDTH
    const depthFocused = this.focus === "depth" || this.focus === "brokers"
    this.leftPanel.width = compact ? 30 : 36
    this.centerPanel.visible = !compact || (this.focus !== "news" && !depthFocused)
    this.depthColumn.visible = compact ? depthFocused : wide || depthFocused
    this.rightPanel.visible = compact ? this.focus === "news" : wide || !depthFocused
    this.depthColumn.width = compact ? "auto" : DEPTH_PANEL_WIDTH
    this.depthColumn.flexGrow = compact ? 1 : 0
    this.rightPanel.width = compact ? "auto" : 46
    this.rightPanel.flexGrow = compact ? 1 : 0
  }

  // "● live" (green) once real stream ticks are flowing, "○ snapshot" (gray)
  // while the list is showing the opening screener values.
  private renderViopHeader(): void {
    const titleColor = this.focus === "instruments" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    const statusColor = this.connected ? UP_COLOR : NEUTRAL_COLOR
    const status = this.connected ? "● live" : "○ snapshot"
    this.viopHeader.content = t`${fg(titleColor)("VIOP")}  ${fg(statusColor)(status)}`
  }

  private selectInstrumentSort(sort: InstrumentSort): void {
    const selectedUid = this.instruments[this.instrumentList.selectedIndex]?.uid
    if (this.instrumentSort === sort) this.sortDirection = this.sortDirection === "desc" ? "asc" : "desc"
    else {
      this.instrumentSort = sort
      this.sortDirection = "desc"
    }
    this.sortAndRenderInstrumentList(selectedUid)
    this.paintSortToolbar()
    this.savePreferences({ instrumentSort: this.instrumentSort, sortDirection: this.sortDirection })
  }

  private savePreferences(update: Partial<WatchlistPreferences>): void {
    this.preferences = { ...this.preferences, ...update }
    this.options.onPreferencesChange?.({ ...this.preferences })
  }

  private sortAndRenderInstrumentList(selectedUid?: string, preserveScroll = false): void {
    this.instruments.sort(instrumentComparator(this.instrumentSort, this.sortDirection))
    this.symbolIndex.clear()
    this.instruments.forEach((instrument, index) => this.symbolIndex.set(instrument.symbol, index))
    this.instrumentList.setRows(
      this.instruments.map((instrument) => ({
        id: instrument.uid,
        content: formatInstrumentRow(instrument),
        color: changeColor(instrument.changePercent),
      })),
      selectedUid,
      { preserveScroll },
    )
  }

  private paintSortToolbar(): void {
    for (const sort of ["change", "volume"] as const) {
      const active = this.instrumentSort === sort
      const button = this.sortButtons.get(sort)
      const label = this.sortButtonLabels.get(sort)
      if (!button || !label) continue
      const direction = active ? (this.sortDirection === "desc" ? " ↓" : " ↑") : ""
      button.backgroundColor = active ? SELECTED_ROW_BG : undefined
      label.content = `${SORT_LABELS[sort]}${direction}`
      label.fg = active ? HEADER_COLOR : this.focus === "instruments" ? "#aaaaaa" : UNFOCUSED_HEADER
    }
  }
}

function newsRowContent(article: NewsArticle) {
  if (!article.tag) return t`${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
  return t`${fg(NEWS_TIME_COLOR)(article.tag)}\n${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
}

function panelHeader(renderer: RenderContext, title: string): TextRenderable {
  return new TextRenderable(renderer, {
    content: title,
    fg: HEADER_COLOR,
    marginBottom: 1,
  })
}

// Recovers the session reference (previous close) from the opening snapshot so
// live ticks can be turned back into a daily change percentage.
function referenceClose(instrument: ViopInstrument): number | null {
  if (instrument.lastPrice === null || instrument.changePercent === null) return null
  const reference = instrument.lastPrice / (1 + instrument.changePercent / 100)
  return Number.isFinite(reference) && reference > 0 ? reference : null
}

function newsListChanged(current: NewsArticle[], next: NewsArticle[]): boolean {
  if (current.length !== next.length) return true
  return next.some((article, index) => article.uid !== current[index]?.uid)
}

function changeColor(changePercent: number | null): string {
  if (changePercent === null) return NEUTRAL_COLOR
  return changePercent >= 0 ? UP_COLOR : DOWN_COLOR
}

function formatInstrumentRow(instrument: ViopInstrument): string {
  const name = instrument.displayName.padEnd(6)
  const price =
    instrument.lastPrice !== null
      ? instrument.lastPrice.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : ""
  const change =
    instrument.changePercent !== null
      ? `${instrument.changePercent >= 0 ? "+" : ""}${instrument.changePercent.toFixed(2)}%`
      : ""
  return `${name}  ${price.padStart(10)}  ${change.padStart(7)}`
}

function instrumentComparator(sort: InstrumentSort, direction: SortDirection): (left: ViopInstrument, right: ViopInstrument) => number {
  return (left, right) => {
    const leftValue = sort === "change" ? left.changePercent : left.volume
    const rightValue = sort === "change" ? right.changePercent : right.volume
    if (leftValue === null && rightValue !== null) return 1
    if (leftValue !== null && rightValue === null) return -1
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return direction === "desc" ? rightValue - leftValue : leftValue - rightValue
    }
    return left.displayName.localeCompare(right.displayName)
  }
}

function isCapitalShortcut(key: KeyEvent, letter: "a" | "c" | "g" | "t" | "v"): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.sequence === letter.toUpperCase() || (key.shift && key.name === letter)
}

function isLowercaseShortcut(key: KeyEvent, letter: "c" | "x"): boolean {
  if (key.ctrl || key.shift || key.meta || key.option) return false
  return key.name === letter && key.sequence !== letter.toUpperCase()
}

function destructiveActionForKey(key: KeyEvent): DestructiveAction | null {
  if (isLowercaseShortcut(key, "c")) return "cancel-orders"
  if (isLowercaseShortcut(key, "x")) return "exit-positions"
  return null
}

function isTickerSearchKey(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.name === "/" || key.sequence === "/"
}

function tickerSearchCharacter(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  const character = key.sequence || key.name
  return /^[\p{L}\p{N}_.-]$/u.test(character) ? character : null
}

function normalizedTickerSearch(value: string): string {
  return value.trim().toUpperCase()
}

function tickerSearchScore(instrument: ViopInstrument, query: string): number | null {
  const values = [instrument.displayName, instrument.underlyingSymbol, instrument.symbol]
    .filter((value): value is string => Boolean(value))
    .map(normalizedTickerSearch)
  if (values.some((value) => value === query || value === `F_${query}`)) return 0
  if (values.some((value) => value.startsWith(query) || value.startsWith(`F_${query}`))) return 1
  return values.some((value) => value.includes(query)) ? 2 : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
