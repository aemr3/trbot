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
import type { OverviewGenerator } from "../ai/overview.ts"
import { AccountPanel } from "../components/account-panel.ts"
import { BrokerageDateModal } from "../components/brokerage-date-modal.ts"
import { BrokeragePanel, brokerageSideOf, settlementModeOf } from "../components/brokerage-panel.ts"
import { CandlestickChart } from "../components/candlestick-chart.ts"
import { PortfolioPanel } from "../components/portfolio-panel.ts"
import { DepthPanel } from "../components/depth-panel.ts"
import { OverviewPanel } from "../components/overview-panel.ts"
import { DOUBLE_CLICK_MS, SelectableList } from "../components/selectable-list.ts"
import { isShortcutHelpKey, ShortcutHelp, type ShortcutHelpSection } from "../components/shortcut-help.ts"
import { ProviderAccountModal } from "../components/provider-account-modal.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
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
} from "../market/broker-calendar.ts"
import type { BrokerageDistributionSource, BrokerageSide } from "../market/brokerage.ts"
import {
  averageTrueRange,
  closedCandles,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "../market/candle.ts"
import type { DepthBook, DepthStream } from "../market/depth.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "../market/equity-quote-stream.ts"
import {
  contractOrderCost,
  type ViopContractDetails,
  type ViopInstrument,
  type ViopInstrumentSource,
} from "../market/instrument.ts"
import type { NewsArticle, NewsSource } from "../market/news.ts"
import {
  buildOverviewDigest,
  isSameDigest,
  type OverviewMode,
  type OverviewSnapshot,
  type OverviewSnapshotStore,
} from "../market/overview.ts"
import { TradeFlowAccumulator } from "../market/trade-flow.ts"
import { StopMonitor, rangeForInterval, type StopRuleView, type StopTriggerEvent } from "../trading/stop-monitor.ts"
import type { StopRule, StopRuleStore } from "../trading/stop.ts"
import { AlertMonitor, type AlertTriggerEvent, type PriceAlertView } from "../market/alert-monitor.ts"
import type { PriceAlert, PriceAlertStore } from "../market/alert.ts"
import type { SoundPlayer } from "../components/sound.ts"
import { AlertEditor } from "./alert-editor.ts"
import { AlertPopup } from "./alert-popup.ts"
import { StopRuleEditor } from "./stop-rule-editor.ts"
import { StopTriggerConfirmation } from "./stop-trigger-confirmation.ts"
import type { QuoteStream, QuoteUpdate } from "../market/quote-stream.ts"
import type { SettlementMode, SettlementSource } from "../market/settlement.ts"
import type { MemberFeatureSource } from "../member/features.ts"
import type { AccountPosition, AccountSource, AccountStream } from "../trading/account.ts"
import type {
  ViopOrderCancellationSource,
  ViopOrderSide,
  ViopOrderSource,
  ViopPositionExitSource,
} from "../trading/order.ts"
import { ViopOrderTicket } from "./order-ticket.ts"
import {
  DEFAULT_SORT_DIRECTIONS,
  DEFAULT_WATCHLIST_PREFERENCES,
  INSTRUMENT_SORTS,
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
// The sidebar's own padding takes two columns, so the panels inside get two
// less: the portfolio's title, its six padded range chips and the gap they keep
// from the panel edge need 37 of the 38 this leaves. A narrow terminal cannot
// afford that, and the portfolio header clips itself instead.
const SIDEBAR_WIDTH = 40
const COMPACT_SIDEBAR_WIDTH = 30
// What the instrument list spends on chrome rather than on a row: the sidebar's
// own padding, the list's selection indicator, its scrollbar gutter, and two
// columns of breathing room so the change column does not sit on the edge.
const SIDEBAR_LIST_CHROME = 8
const BROKERAGE_POLL_INTERVAL_MS = 60_000
// Each panel is guaranteed the rows its fixed content needs, then both grow at
// the same rate so whatever the terminal has left over is split evenly.
const DEPTH_PANEL_BASIS = 19
const BROKERAGE_PANEL_BASIS = 9
// The news list and the AI overview share the right column the same way.
const NEWS_SECTION_BASIS = 16
const OVERVIEW_PANEL_BASIS = 12
const OVERVIEW_POLL_INTERVAL_MS = 300_000
// Flipping through tickers should not spend an AI call per keystroke.
const OVERVIEW_DEBOUNCE_MS = 5_000
// The two price-history reads behind the overview digest: the session at a
// quarter-hour grain and a year of dailies for the standing trend.
const OVERVIEW_INTRADAY: [CandleRange, CandleInterval] = ["INTRADAY", "MIN_15"]
const OVERVIEW_DAILY: [CandleRange, CandleInterval] = ["YEAR", "DAY_1"]
// The instrument list, depth ladder and news feed together claim 130 fixed
// columns, so the depth panel only joins them permanently once the chart and
// account column can still keep about 60. Below that it takes the news slot
// while it holds focus instead.
const DEPTH_LAYOUT_WIDTH = 190
// How often close-based and ATR stop rules re-read their candles. Anything
// finer just re-reads the same forming candle.
const STOP_CANDLE_POLL_INTERVAL_MS = 30_000
const SORT_LABELS: Record<InstrumentSort, string> = { change: "Change", volume: "Volume", name: "Name" }
const NEWS_FEEDS = ["instrument", "index"] as const
type NewsFeed = (typeof NEWS_FEEDS)[number]
type DestructiveAction = "cancel-orders" | "exit-positions" | "delete-stop" | "delete-alert"
const NEWS_FEED_LABELS: Record<NewsFeed, string> = { instrument: "Stock", index: "Index" }
const WATCHLIST_HINT = "B/S trade · G logs · / ticker · ? help · Ctrl+C quit"
const WATCHLIST_SHORTCUTS: ShortcutHelpSection[] = [
  {
    title: "Global",
    bindings: [
      { keys: "?", description: "Toggle this help" },
      { keys: "A", description: "Open AI provider account" },
      { keys: "O", description: "Focus the AI overview and regenerate" },
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
      { keys: "N", description: "Sort by ticker" },
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
      { keys: "←/→ or h/l", description: "Switch view: buyers, sellers, held, gained, lost" },
      { keys: "↑/↓ or j/k", description: "Scroll beyond the leading houses" },
      { keys: "Home", description: "Back to the top of the list" },
      { keys: "d", description: "Change the date range" },
    ],
  },
  {
    title: "Portfolio",
    bindings: [
      { keys: "←/→ or h/l", description: "Change performance range: 1W, 1M, 3M, YTD, 1Y, All" },
    ],
  },
  {
    title: "Account",
    bindings: [
      { keys: "←/→ or h/l", description: "Change tab: portfolio, orders, positions, stops, alerts" },
      { keys: "↑/↓ or j/k", description: "Scroll" },
      { keys: "Home", description: "Scroll to top" },
      { keys: "R", description: "Refresh account" },
    ],
  },
  {
    title: "Stops",
    bindings: [
      { keys: "n", description: "New protective level for a position" },
      { keys: "e / Enter", description: "Edit the selected rule" },
      { keys: "Space", description: "Arm or pause the selected rule" },
      { keys: "d d", description: "Delete the selected rule" },
      { keys: "↑/↓ or j/k", description: "Move between rules" },
    ],
  },
  {
    title: "Stop trigger",
    bindings: [
      { keys: "Enter", description: "Send the exit now" },
      { keys: "p", description: "Hold the countdown" },
      { keys: "Esc", description: "Cancel and stand the rule down" },
    ],
  },
  {
    title: "Alerts",
    bindings: [
      { keys: "n", description: "New price alert on a contract" },
      { keys: "e / Enter", description: "Edit the selected alert" },
      { keys: "Space", description: "Arm or pause the selected alert" },
      { keys: "d d", description: "Delete the selected alert" },
      { keys: "↑/↓ or j/k", description: "Move between alerts" },
    ],
  },
  {
    title: "Alert popup",
    bindings: [
      { keys: "r", description: "Re-arm the same level" },
      { keys: "Any key", description: "Dismiss; nothing is ever traded" },
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
    title: "AI overview",
    bindings: [
      { keys: "←/→ or h/l", description: "Switch intraday / daily view" },
      { keys: "r / Enter", description: "Regenerate the overview" },
      { keys: "↑/↓ or j/k", description: "Scroll the commentary" },
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
  settlement?: SettlementSource
  memberFeatures?: MemberFeatureSource
  overview?: OverviewGenerator
  overviewSnapshots?: OverviewSnapshotStore
  stopRules?: StopRuleStore
  stopCandleIntervalMs?: number
  stopStalePriceMs?: number
  stopCountdownMs?: number
  priceAlerts?: PriceAlertStore
  sound?: SoundPlayer
  onSessionExpired?: () => void
  newsIntervalMs?: number
  instrumentIntervalMs?: number
  accountIntervalMs?: number
  brokerageIntervalMs?: number
  overviewIntervalMs?: number
  overviewDebounceMs?: number
  destructiveConfirmationTimeoutMs?: number
  preferences?: WatchlistPreferences
  onPreferencesChange?: (preferences: WatchlistPreferences) => void
  chatGptAccount?: ChatGptAccount
  logs?: ApplicationLog
  manageInput?: boolean
  onOpenLogs?: () => void
}

type Focus = "instruments" | "portfolio" | "chart" | "depth" | "brokers" | "account" | "news" | "overview"

export class WatchlistScreen {
  readonly root: BoxRenderable

  private readonly leftPanel: BoxRenderable
  private readonly centerPanel: BoxRenderable
  private readonly instrumentList: SelectableList
  private readonly portfolioPanel: PortfolioPanel
  private readonly sortButtons = new Map<InstrumentSort, BoxRenderable>()
  private readonly sortButtonLabels = new Map<InstrumentSort, TextRenderable>()
  private readonly chart: CandlestickChart
  private readonly chartHeader: TextRenderable
  private readonly accountPanel: AccountPanel
  private readonly depthColumn: BoxRenderable
  private readonly depthPanel: DepthPanel
  private readonly brokeragePanel: BrokeragePanel
  private readonly rightPanel: BoxRenderable
  private readonly newsSection: BoxRenderable
  private readonly overviewPanel: OverviewPanel
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
  // With the list sorted by change, every tick can reorder it; ticks mutate
  // the instruments and the resort runs once per burst.
  private readonly listResort = new RenderCoalescer(() => {
    if (this.destroyed) return
    const selectedUid = this.instruments[this.instrumentList.selectedIndex]?.uid
    this.sortAndRenderInstrumentList(selectedUid, true)
  })
  private sessionExpiredNotified = false
  private newsRequestUid: string | null = null
  private articleRequestUid: string | null = null
  private contractDetailsRequest: AbortController | null = null
  // The selected contract's details, kept so the chart can price one lot.
  private contractDetails: ViopContractDetails | null = null
  private tradingActionRequest: AbortController | null = null
  private readerLastClickAt = 0
  private newsTimer: ReturnType<typeof setInterval> | null = null
  private instrumentTimer: ReturnType<typeof setInterval> | null = null
  private instrumentRefreshRequest: AbortController | null = null
  private memberFeatureRequest: AbortController | null = null
  private depthEntitled: boolean | null = null
  private brokerageEntitled: boolean | null = null
  private settlementEntitled: boolean | null = null
  // The panel shows one broker view at a time, so a single in-flight request,
  // date range and calendar are shared by both feeds behind it.
  private brokerageRequest: AbortController | null = null
  private brokerageTimer: ReturnType<typeof setInterval> | null = null
  private brokerageRange: BrokerageDateRange = DEFAULT_BROKERAGE_RANGE
  private brokeragePresets: BrokerageDatePreset[] = []
  private brokerageDates: string[] = []
  private brokerageLive = false
  private brokerageDateModal: BrokerageDateModal | null = null
  // The AI overview joins the live book and tape with the broker feeds; every
  // finished run is cached per instrument so revisiting a ticker is free. The
  // cache is seeded from, and written through to, the snapshot store, so the
  // readings survive a restart.
  private readonly tradeFlow = new TradeFlowAccumulator()
  private latestDepthBook: DepthBook | null = null
  private readonly overviewCache = new Map<string, OverviewSnapshot>()
  // Protective levels for open positions. The monitor watches prices; the
  // screen owns the confirmation and the order that follows it.
  private readonly stopMonitor: StopMonitor | null
  private stopRuleEditor: StopRuleEditor | null = null
  private stopTrigger: StopTriggerConfirmation | null = null
  private stopCandleTimer: ReturnType<typeof setInterval> | null = null
  // Breaches waiting for the confirmation modal, so two levels reached at once
  // are answered one at a time instead of racing.
  private readonly stopTriggerQueue: StopTriggerEvent[] = []
  // Price levels the trader asked to be told about. Same watching, none of the
  // trading: a reached level rings and shows a notice, and that is all.
  private readonly alertMonitor: AlertMonitor | null
  private alertEditor: AlertEditor | null = null
  private alertPopup: AlertPopup | null = null
  private alertCandleTimer: ReturnType<typeof setInterval> | null = null
  private readonly alertQueue: AlertTriggerEvent[] = []
  private positions: AccountPosition[] = []
  // Whether the account has ever answered. Until it has, an empty position list
  // means "not known yet", which is not the same as "nothing is open".
  private positionsKnown = false
  private overviewEntitled: boolean | null = null
  private overviewRequest: AbortController | null = null
  private overviewTimer: ReturnType<typeof setInterval> | null = null
  private overviewDebounce: ReturnType<typeof setTimeout> | null = null
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private destructiveConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private equityConnected = false
  private selectedEquitySymbol: string | null = null
  private preferences: WatchlistPreferences
  private instrumentSort: InstrumentSort
  private sortDirection: SortDirection

  private readonly handleKeypress = (key: KeyEvent): void => {
    // Deleting a stop rule is only offered where one is selected, so its key is
    // read against the focused panel rather than globally.
    const destructiveAction = destructiveActionForKey(key)
      ?? (this.focus === "account" && isLowercaseShortcut(key, "d")
        ? this.accountPanel.selectedStop()
          ? "delete-stop"
          : this.accountPanel.selectedAlert()
            ? "delete-alert"
            : null
        : null)
    if (!destructiveAction) this.clearDestructiveConfirmation()
    // A triggered stop is about to send a live order: it answers before
    // anything else on screen.
    if (this.stopTrigger) {
      this.stopTrigger.handleKey(key)
      return
    }
    // A fired alert is only a notice, so it sits behind the stop but in front
    // of everything the trader might otherwise type into.
    if (this.alertPopup) {
      this.alertPopup.handleKey(key)
      return
    }
    if (this.stopRuleEditor) {
      this.stopRuleEditor.handleKey(key)
      return
    }
    if (this.alertEditor) {
      this.alertEditor.handleKey(key)
      return
    }
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
    if (isCapitalShortcut(key, "o")) {
      this.setFocus("overview")
      void this.generateOverview({ force: true })
      return
    }
    if (!key.ctrl && (key.name === "b" || key.name === "s")) {
      this.openOrderTicket(key.name === "b" ? "BUY" : "SELL")
      return
    }
    if (destructiveAction) {
      if (this.confirmDestructiveAction(destructiveAction)) {
        if (destructiveAction === "cancel-orders") void this.cancelAllPendingOrders()
        else if (destructiveAction === "exit-positions") void this.exitAllPositions()
        else if (destructiveAction === "delete-alert") void this.deleteSelectedAlert()
        else void this.deleteSelectedStopRule()
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
    // The portfolio panel only owns its range keys; anything else falls through
    // to the instrument list, which is what the arrow keys mean everywhere else
    // in this column.
    if (this.focus === "portfolio" && this.portfolioPanel.handleKey(key)) return
    if (this.focus === "overview") {
      this.overviewPanel.handleKey(key)
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
    else if (isCapitalShortcut(key, "n")) this.selectInstrumentSort("name")
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
      // Kept in step with updateResponsiveLayout, which owns this from the
      // first resize onward.
      width: SIDEBAR_WIDTH,
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
    for (const sort of INSTRUMENT_SORTS) {
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
    this.portfolioPanel = new PortfolioPanel(renderer, {
      onFocusRequest: () => this.setFocus("portfolio"),
      onRangeChange: () => void this.accountPanel.refresh(),
    })
    this.leftPanel.add(this.portfolioPanel.root)

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
      onPositionsChange: (positions) => this.onPositionsChange(positions),
      onPortfolioChange: (portfolio) => this.portfolioPanel.showPortfolio(portfolio),
      onPerformanceChange: (performance) => this.portfolioPanel.showPerformance(performance),
      portfolioRange: () => this.portfolioPanel.activeRange,
      onStopCreate: () => this.openStopRuleEditor(),
      onStopEdit: (view) => this.openStopRuleEditor(view.rule),
      onStopToggle: (view) => void this.toggleStopRule(view),
      onAlertCreate: () => this.openAlertEditor(),
      onAlertEdit: (view) => this.openAlertEditor(view.alert),
      onAlertToggle: (view) => void this.togglePriceAlert(view),
    })
    this.centerPanel.add(this.accountPanel.root)

    this.stopMonitor = options.stopRules
      ? new StopMonitor({
          store: options.stopRules,
          candles: options.candles,
          stalePriceMs: options.stopStalePriceMs,
          onTrigger: (event) => this.onStopTrigger(event),
          onChange: () => this.accountPanel.showStopRules(this.stopMonitor?.views() ?? []),
          onError: (error) => this.reportError("Stop manager", error),
        })
      : null

    this.alertMonitor = options.priceAlerts
      ? new AlertMonitor({
          store: options.priceAlerts,
          candles: options.candles,
          stalePriceMs: options.stopStalePriceMs,
          onTrigger: (event) => this.onAlertTrigger(event),
          onChange: () => this.accountPanel.showPriceAlerts(this.alertMonitor?.views() ?? []),
          onError: (error) => this.reportError("Price alerts", error),
        })
      : null

    // The order book and the broker distribution share one column: each keeps
    // the rows its fixed content needs and they split the remainder evenly.
    this.depthColumn = new BoxRenderable(renderer, { flexDirection: "column" })
    this.depthPanel = new DepthPanel(renderer, { onFocusRequest: () => this.setFocus("depth") })
    this.depthPanel.setEntitled(options.memberFeatures ? null : false)
    this.depthPanel.root.flexBasis = DEPTH_PANEL_BASIS
    this.depthPanel.root.flexGrow = 1
    this.brokeragePanel = new BrokeragePanel(renderer, {
      onViewChange: () => this.loadBrokerView(),
      onOpenDateRange: () => this.openBrokerageDateModal(),
      onFocusRequest: () => this.setFocus("brokers"),
    })
    this.brokeragePanel.setDistributionEntitled(options.memberFeatures ? null : false)
    this.brokeragePanel.setSettlementEntitled(options.memberFeatures ? null : false)
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
    // News and the AI overview share the column: each keeps the rows its fixed
    // content needs and they split the remainder, like the depth column does.
    this.newsSection = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      flexBasis: NEWS_SECTION_BASIS,
      flexGrow: 1,
    })
    // Like the AI overview beneath it, one row carries the title and the feed
    // tabs so the list keeps the remaining lines.
    const newsFeedToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
      gap: 1,
      marginBottom: 1,
    })
    this.newsHeader = new TextRenderable(renderer, {
      content: "News",
      fg: HEADER_COLOR,
      marginRight: 1,
      wrapMode: "none",
    })
    newsFeedToolbar.add(this.newsHeader)
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
    this.newsSection.add(newsFeedToolbar)
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
    this.rightPanel.add(this.newsSection)
    this.overviewPanel = new OverviewPanel(renderer, {
      onGenerate: () => void this.generateOverview({ force: true }),
      onModeChange: () => this.selectOverviewMode(),
      onFocusRequest: () => this.setFocus("overview"),
    })
    this.overviewPanel.setEntitled(options.memberFeatures ? null : false)
    this.overviewPanel.root.flexBasis = OVERVIEW_PANEL_BASIS
    this.overviewPanel.root.flexGrow = 1
    this.rightPanel.add(this.overviewPanel.root)

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
    this.options.depth?.subscribe((book) => {
      this.depthPanel.showBook(book)
      this.ingestOverviewBook(book)
    })
    this.options.depth?.onStatusChange((status) => this.depthPanel.setStatus(status))
  }

  mount(): void {
    if (this.options.manageInput !== false) this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.updateFocusIndicator()
    this.accountPanel.mount()
    void this.load()
    void this.loadMemberFeatures()
    void this.loadOverviewSnapshots()
    void this.loadStopRules()
    void this.loadPriceAlerts()
    this.newsTimer = setInterval(() => void this.refreshNews(), this.options.newsIntervalMs ?? NEWS_POLL_INTERVAL_MS)
    this.instrumentTimer = setInterval(
      () => void this.refreshInstruments(),
      this.options.instrumentIntervalMs ?? INSTRUMENT_POLL_INTERVAL_MS,
    )
    // A historical range is settled, so only a range covering the open session
    // is worth re-reading.
    this.brokerageTimer = setInterval(() => {
      if (this.brokerageLive) this.loadBrokerView(true)
    }, this.options.brokerageIntervalMs ?? BROKERAGE_POLL_INTERVAL_MS)
    // The AI overview refreshes itself while the market moves; a closed session
    // keeps whatever run is cached.
    this.overviewTimer = setInterval(() => {
      if (this.isMarketOpenForOverview()) void this.generateOverview()
    }, this.options.overviewIntervalMs ?? OVERVIEW_POLL_INTERVAL_MS)
    // Close-based and ATR rules read candles rather than ticks.
    if (this.stopMonitor) {
      this.stopCandleTimer = setInterval(
        () => void this.stopMonitor?.refreshCandleRules(),
        this.options.stopCandleIntervalMs ?? STOP_CANDLE_POLL_INTERVAL_MS,
      )
    }
    if (this.alertMonitor) {
      this.alertCandleTimer = setInterval(
        () => void this.alertMonitor?.refreshCandleAlerts(),
        this.options.stopCandleIntervalMs ?? STOP_CANDLE_POLL_INTERVAL_MS,
      )
    }
    void this.refreshOverviewConnection()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listResort.cancel()
    this.chart.destroy()
    this.accountPanel.destroy()
    this.tickerSearchQuery = null
    this.closeShortcutHelp()
    this.closeProviderAccount()
    this.closeOrderTicket()
    this.closeStopRuleEditor()
    this.closeStopTrigger()
    this.closeAlertEditor()
    this.closeAlertPopup()
    this.stopMonitor?.destroy()
    this.alertMonitor?.destroy()
    if (this.alertCandleTimer) {
      clearInterval(this.alertCandleTimer)
      this.alertCandleTimer = null
    }
    if (this.stopCandleTimer) {
      clearInterval(this.stopCandleTimer)
      this.stopCandleTimer = null
    }
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
    this.overviewRequest?.abort()
    this.overviewRequest = null
    this.overviewPanel.destroy()
    this.closeBrokerageDateModal()
    if (this.brokerageTimer) {
      clearInterval(this.brokerageTimer)
      this.brokerageTimer = null
    }
    if (this.overviewTimer) {
      clearInterval(this.overviewTimer)
      this.overviewTimer = null
    }
    if (this.overviewDebounce) {
      clearTimeout(this.overviewDebounce)
      this.overviewDebounce = null
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
        this.syncQuoteSubscription()
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
      this.setSettlementEntitled(features.has("SETTLEMENT_ANALYSIS"))
      this.setOverviewEntitled(
        features.has("MARKET_DEPTH") || features.has("BROKERAGE_DISTRIBUTION") || features.has("SETTLEMENT_ANALYSIS"),
      )
    } catch (error) {
      if (this.destroyed || request.signal.aborted || isAbortError(error)) return
      this.reportError("Member features", error)
      this.setDepthEntitled(false)
      this.setBrokerageEntitled(false)
      this.setSettlementEntitled(false)
      this.setOverviewEntitled(false)
    } finally {
      if (this.memberFeatureRequest === request) this.memberFeatureRequest = null
    }
  }

  // Reads whichever broker view the panel is showing. Only one is on screen at
  // a time, so a new read cancels the one in flight whichever feed it came from.
  private loadBrokerView(background = false): void {
    const view = this.brokeragePanel.activeView
    const side = brokerageSideOf(view)
    if (side) void this.loadBrokerage(side, background)
    const mode = settlementModeOf(view)
    if (mode) void this.loadSettlement(mode, background)
  }

  // Reads the ranked broker houses for the selected contract's underlying. The
  // figures keep moving while the range covers the open session, so a poll
  // refreshes them in the background and leaves the last good table on screen
  // when a refresh fails.
  private async loadBrokerage(side: BrokerageSide, background: boolean): Promise<void> {
    const source = this.options.brokerage
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!source || !instrument || !this.brokerageEntitled || this.destroyed) return
    const request = this.startBrokerRequest()
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

  // Reads the settlement register behind the same stock: what the houses were
  // left holding once the range cleared, and who added to or shed a position.
  private async loadSettlement(mode: SettlementMode, background: boolean): Promise<void> {
    const source = this.options.settlement
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!source || !instrument || !this.settlementEntitled || this.destroyed) return
    const request = this.startBrokerRequest()
    try {
      const analysis = await source.loadSettlement({
        instrumentUid: instrument.uid,
        mode,
        range: this.brokerageRange,
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.brokerageRequest !== request) return
      this.brokeragePresets = analysis.presets
      this.brokerageDates = analysis.availableDates
      this.brokerageLive = analysis.live
      this.brokeragePanel.showSettlement(analysis)
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.brokerageRequest !== request || isAbortError(error)) return
      if (this.reportError("Settlement analysis", error)) return
      if (!background) this.brokeragePanel.showMessage(`Failed to load: ${errorMessage(error)}`, "#ff6b6b")
    } finally {
      if (this.brokerageRequest === request) this.brokerageRequest = null
    }
  }

  private startBrokerRequest(): AbortController {
    this.brokerageRequest?.abort()
    const request = new AbortController()
    this.brokerageRequest = request
    return request
  }

  private openBrokerageDateModal(): void {
    if (this.destroyed || this.brokerageDateModal) return
    if (this.brokerageDates.length === 0 && this.brokeragePresets.length === 0) {
      this.showHintStatus("The broker calendar has not loaded yet.", "#e5c07b", 3_000)
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
    this.loadBrokerView()
  }

  private setBrokerageEntitled(entitled: boolean): void {
    if (this.brokerageEntitled === entitled) return
    this.brokerageEntitled = entitled
    this.brokeragePanel.setDistributionEntitled(entitled)
    // Only the feed behind the view on screen is worth reading; the other one
    // loads when its tab is opened.
    const side = brokerageSideOf(this.brokeragePanel.activeView)
    if (entitled && side) void this.loadBrokerage(side, false)
  }

  private setSettlementEntitled(entitled: boolean): void {
    if (this.settlementEntitled === entitled) return
    this.settlementEntitled = entitled
    this.brokeragePanel.setSettlementEntitled(entitled)
    const mode = settlementModeOf(this.brokeragePanel.activeView)
    if (entitled && mode) void this.loadSettlement(mode, false)
  }

  private setDepthEntitled(entitled: boolean): void {
    if (this.depthEntitled === entitled) return
    this.depthEntitled = entitled
    this.depthPanel.setEntitled(entitled)
    this.syncDepthSubscription()
  }

  // The overview reads whichever of the three broker feeds the member has; it
  // only locks when none of them is available.
  private setOverviewEntitled(entitled: boolean): void {
    if (this.overviewEntitled === entitled) return
    this.overviewEntitled = entitled
    this.overviewPanel.setEntitled(entitled)
    if (entitled) this.scheduleOverviewGeneration()
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
    // All of these run before the watchlist lookup below: a protected position
    // or a watched level need not be a row in the list.
    this.stopMonitor?.applyQuote(update)
    this.stopTrigger?.applyQuote(update)
    this.alertMonitor?.applyQuote(update)
    this.alertPopup?.applyQuote(update)
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
    // What a lot costs moves with the price, and it rides the chart's OHLC line.
    if (update.lastPrice !== null && this.instruments[this.instrumentList.selectedIndex]?.uid === instrument.uid) {
      this.refreshContractCost()
    }
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
      if (selected) void this.loadContractDetails(selected)
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
      this.listResort.schedule()
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
    // The old contract's cost must not linger over a new one.
    this.contractDetails = null
    this.refreshContractCost()
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
    this.loadBrokerView()
    this.selectOverviewInstrument(instrument)
    this.renderChartHeader()
    void this.loadNews(instrument)
  }

  // The tape starts over with the new instrument; a cached run shows instantly,
  // an uncached one generates after a pause — even with the market closed, so
  // every instrument gets at least one reading from the last available data.
  private selectOverviewInstrument(instrument: ViopInstrument): void {
    this.tradeFlow.reset()
    this.latestDepthBook = null
    this.overviewRequest?.abort()
    this.overviewRequest = null
    const cached = this.overviewCache.get(overviewCacheKey(instrument.uid, this.overviewPanel.activeMode))
    if (cached) this.overviewPanel.showSnapshot(cached)
    else this.overviewPanel.reset()
    if (!cached) this.scheduleOverviewGeneration()
  }

  // Switching between the intraday and daily views: each keeps its own cached
  // run, and an uncached view generates right away — the switch asked for it.
  private selectOverviewMode(): void {
    if (this.destroyed) return
    this.overviewRequest?.abort()
    this.overviewRequest = null
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    const cached = instrument
      ? this.overviewCache.get(overviewCacheKey(instrument.uid, this.overviewPanel.activeMode))
      : undefined
    if (cached) {
      this.overviewPanel.showSnapshot(cached)
      return
    }
    this.overviewPanel.reset()
    void this.generateOverview()
  }

  // Seeds the cache with the readings a previous run left behind, then shows
  // the one belonging to the current selection unless a run is already writing.
  private async loadOverviewSnapshots(): Promise<void> {
    const store = this.options.overviewSnapshots
    if (!store) return
    try {
      const stored = await store.list()
      if (this.destroyed) return
      for (const snapshot of stored) {
        this.overviewCache.set(overviewCacheKey(snapshot.instrumentUid, snapshot.mode), {
          digest: snapshot.digest,
          commentary: snapshot.commentary,
          generatedAt: snapshot.generatedAt,
        })
      }
      if (this.overviewRequest) return
      const instrument = this.instruments[this.instrumentList.selectedIndex]
      const cached = instrument
        ? this.overviewCache.get(overviewCacheKey(instrument.uid, this.overviewPanel.activeMode))
        : undefined
      if (cached) this.overviewPanel.showSnapshot(cached)
    } catch (error) {
      this.reportError("AI overview cache", error)
    }
  }

  // ── Stop rules ─────────────────────────────────────────────────────────────

  private async loadStopRules(): Promise<void> {
    const monitor = this.stopMonitor
    if (!monitor) return
    await monitor.load()
    if (this.destroyed) return
    // Deliberately no setPositions here. The account has not reported yet, and
    // an empty list would read as "every position is closed" — which ends every
    // rule on the list, permanently and on disk. onPositionsChange does it once
    // the account actually answers.
    if (this.positionsKnown) monitor.setPositions(this.positions)
    this.accountPanel.showStopRules(monitor.views())
    // Rules can protect contracts the watchlist does not carry.
    this.syncQuoteSubscription()
    // Read candles now rather than waiting out the first poll: a close-based
    // rule has no ticks to fall back on, so until this lands it looks like a
    // rule with no feed instead of one that is simply between reads.
    void monitor.refreshCandleRules()
  }

  private onPositionsChange(positions: AccountPosition[]): void {
    this.positions = positions
    this.positionsKnown = true
    this.stopMonitor?.setPositions(positions)
    this.syncQuoteSubscription()
  }

  /** Subscribes to the watchlist plus whatever rules and alerts need watched. */
  private syncQuoteSubscription(): void {
    const symbols = new Set(this.instruments.map((instrument) => instrument.symbol))
    for (const symbol of this.stopMonitor?.symbols() ?? []) symbols.add(symbol)
    for (const symbol of this.alertMonitor?.symbols() ?? []) symbols.add(symbol)
    if (symbols.size > 0) this.options.quotes?.start([...symbols])
  }

  private openStopRuleEditor(rule?: StopRule): void {
    if (this.destroyed || this.stopRuleEditor) return
    if (!this.stopMonitor) {
      this.showHintStatus("Stop rules need a database; none is configured.", "#e5c07b", 4_000)
      return
    }
    if (this.positions.length === 0) {
      this.showHintStatus("No open VIOP positions to protect.", "#888888", 3_000)
      return
    }
    this.stopRuleEditor = new StopRuleEditor(this.renderer, {
      positions: this.positions,
      rule,
      lastPrice: (symbol) => this.lastPriceFor(symbol),
      atr: (instrumentUid, interval) => this.readAtr(instrumentUid, interval),
      onSave: (draft) => {
        void this.stopMonitor?.saveRule(draft).then(() => {
          if (this.destroyed) return
          this.syncQuoteSubscription()
          // A close-based rule reads candles, not ticks, so give it its first
          // read now instead of leaving it blank until the poll comes round.
          if (draft.basis === "CLOSE") void this.stopMonitor?.refreshCandleRules()
          this.showHintStatus(`${draft.role === "STOP" ? "Stop" : "Target"} armed for ${draft.displayName}.`, "#70d7a1", 4_000)
        })
        this.closeStopRuleEditor()
      },
      onClose: () => this.closeStopRuleEditor(),
      onError: (error) => this.reportError("Stop manager", error),
    })
    this.root.add(this.stopRuleEditor.root)
    this.stopRuleEditor.mount()
    this.renderer.requestRender()
  }

  private closeStopRuleEditor(): void {
    const editor = this.stopRuleEditor
    if (!editor) return
    this.stopRuleEditor = null
    if (!this.root.isDestroyed && !editor.root.isDestroyed) this.root.remove(editor.root)
    editor.destroy()
    this.renderer.requestRender()
  }

  private async toggleStopRule(view: StopRuleView): Promise<void> {
    const monitor = this.stopMonitor
    if (!monitor) return
    if (view.rule.status === "TRIGGERED") {
      this.showHintStatus("This rule already triggered; edit it to arm a new level.", "#e5c07b", 4_000)
      return
    }
    const armed = view.rule.status === "ARMED"
    await monitor.setStatus(view.rule.id, armed ? "PAUSED" : "ARMED")
    if (this.destroyed) return
    this.showHintStatus(`${view.rule.displayName} ${armed ? "paused" : "armed"}.`, "#888888", 3_000)
  }

  private async deleteSelectedStopRule(): Promise<void> {
    const monitor = this.stopMonitor
    const view = this.accountPanel.selectedStop()
    if (!monitor || !view) return
    await monitor.removeRule(view.rule.id)
    if (this.destroyed) return
    this.syncQuoteSubscription()
    this.showHintStatus(`Deleted the ${view.rule.role === "STOP" ? "stop" : "target"} on ${view.rule.displayName}.`, "#888888", 3_000)
  }

  /**
   * A level was reached. Nothing is sent yet: the trader sees what the exit
   * would be and either lets the countdown run or stops it.
   */
  private onStopTrigger(event: StopTriggerEvent): void {
    this.stopTriggerQueue.push(event)
    this.showNextStopTrigger()
  }

  private showNextStopTrigger(): void {
    if (this.destroyed || this.stopTrigger) return
    const event = this.stopTriggerQueue.shift()
    if (!event) return
    // Its own sound, not the alert's: an order is about to go out, and which of
    // the two fired should be clear without looking at the screen.
    this.options.sound?.play("STOP")
    // Put the rule that fired in front of the trader behind the modal.
    this.accountPanel.selectTab("stops")
    this.setFocus("account")
    this.stopTrigger = new StopTriggerConfirmation(this.renderer, {
      event,
      countdownMs: this.options.stopCountdownMs,
      onConfirm: () => void this.submitStopExit(event),
      onCancel: () => {
        this.closeStopTrigger()
        void this.stopMonitor?.resolveTrigger(event.rule.id, "CANCELLED")
        this.showHintStatus(`Stood down the ${event.rule.displayName} stop; no order sent.`, "#e5c07b", 4_000)
        this.showNextStopTrigger()
      },
    })
    this.root.add(this.stopTrigger.root)
    this.stopTrigger.mount()
    this.renderer.requestRender()
  }

  private closeStopTrigger(): void {
    const modal = this.stopTrigger
    if (!modal) return
    this.stopTrigger = null
    if (!this.root.isDestroyed && !modal.root.isDestroyed) this.root.remove(modal.root)
    modal.destroy()
    this.renderer.requestRender()
  }

  /** Sends the exit a confirmed trigger asked for. */
  private async submitStopExit(event: StopTriggerEvent): Promise<void> {
    const source = this.options.positionExit
    if (this.destroyed) return
    // Nothing can be sent, so say so and leave the rule triggered rather than
    // holding a modal open over a promise that will never resolve.
    if (!source || this.tradingActionRequest) {
      this.closeStopTrigger()
      this.showHintStatus(
        source ? "Another trading action is in flight; exit not sent." : "Position exits are unavailable.",
        "#ff6b6b",
        6_000,
      )
      return
    }
    const request = new AbortController()
    this.tradingActionRequest = request
    this.showHintStatus(`Submitting the ${event.rule.displayName} exit…`, "#e5c07b")
    try {
      const submitted = await source.exitPosition({
        instrumentUid: event.rule.instrumentUid,
        quantity: event.quantity,
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      await this.stopMonitor?.resolveTrigger(event.rule.id, "SUBMITTED", submitted.orderUid)
      void this.accountPanel.refresh()
      this.showHintStatus(
        `Exited ${submitted.quantity} ${submitted.symbol} on the ${event.rule.role === "STOP" ? "stop" : "target"}.`,
        "#70d7a1",
        4_000,
      )
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request || isAbortError(error)) return
      // The rule stays triggered: nothing was closed, and it must not look done.
      if (!this.reportError("Stop exit", error)) {
        this.showHintStatus(`Stop exit failed: ${errorMessage(error)}`, "#ff6b6b", 6_000)
      }
    } finally {
      if (this.tradingActionRequest === request) this.tradingActionRequest = null
      if (!this.destroyed) {
        this.closeStopTrigger()
        this.showNextStopTrigger()
      }
    }
  }

  // ── Price alerts ───────────────────────────────────────────────────────────

  private async loadPriceAlerts(): Promise<void> {
    const monitor = this.alertMonitor
    if (!monitor) return
    await monitor.load()
    if (this.destroyed) return
    this.accountPanel.showPriceAlerts(monitor.views())
    // Alerts can watch contracts the watchlist does not carry.
    this.syncQuoteSubscription()
    // Read candles now rather than waiting out the first poll; see loadStopRules.
    void monitor.refreshCandleAlerts()
  }

  private openAlertEditor(alert?: PriceAlert): void {
    if (this.destroyed || this.alertEditor) return
    if (!this.alertMonitor) {
      this.showHintStatus("Price alerts need a database; none is configured.", "#e5c07b", 4_000)
      return
    }
    if (this.instruments.length === 0) {
      this.showHintStatus("No contracts to watch yet.", "#888888", 3_000)
      return
    }
    this.alertEditor = new AlertEditor(this.renderer, {
      instruments: this.instruments,
      alert,
      instrumentUid: this.instruments[this.instrumentList.selectedIndex]?.uid,
      lastPrice: (symbol) => this.lastPriceFor(symbol),
      atr: (instrumentUid, interval) => this.readAtr(instrumentUid, interval),
      onSave: (draft) => {
        void this.alertMonitor?.saveAlert(draft).then(() => {
          if (this.destroyed) return
          this.syncQuoteSubscription()
          // Same as a close-based stop rule: read its candles straight away.
          if (draft.basis === "CLOSE") void this.alertMonitor?.refreshCandleAlerts()
          this.showHintStatus(
            `Alert set on ${draft.displayName} ${draft.direction === "ABOVE" ? "above" : "below"} the level.`,
            "#70d7a1",
            4_000,
          )
        })
        this.closeAlertEditor()
      },
      onClose: () => this.closeAlertEditor(),
      onError: (error) => this.reportError("Price alerts", error),
    })
    this.root.add(this.alertEditor.root)
    this.alertEditor.mount()
    this.renderer.requestRender()
  }

  private closeAlertEditor(): void {
    const editor = this.alertEditor
    if (!editor) return
    this.alertEditor = null
    if (!this.root.isDestroyed && !editor.root.isDestroyed) this.root.remove(editor.root)
    editor.destroy()
    this.renderer.requestRender()
  }

  private async togglePriceAlert(view: PriceAlertView): Promise<void> {
    const monitor = this.alertMonitor
    if (!monitor) return
    const armed = view.alert.status === "ARMED"
    await monitor.setStatus(view.alert.id, armed ? "PAUSED" : "ARMED")
    if (this.destroyed) return
    this.syncQuoteSubscription()
    this.showHintStatus(`${view.alert.displayName} alert ${armed ? "paused" : "armed"}.`, "#888888", 3_000)
  }

  private async deleteSelectedAlert(): Promise<void> {
    const monitor = this.alertMonitor
    const view = this.accountPanel.selectedAlert()
    if (!monitor || !view) return
    await monitor.removeAlert(view.alert.id)
    if (this.destroyed) return
    this.syncQuoteSubscription()
    this.showHintStatus(`Deleted the ${view.alert.displayName} alert.`, "#888888", 3_000)
  }

  /**
   * A level was reached. Nothing is traded and nothing is pending: the sound
   * and the notice are the whole of what an alert does.
   */
  private onAlertTrigger(event: AlertTriggerEvent): void {
    this.alertQueue.push(event)
    this.showNextAlert()
  }

  private showNextAlert(): void {
    if (this.destroyed || this.alertPopup) return
    const event = this.alertQueue.shift()
    if (!event) return
    this.options.sound?.play("ALERT")
    // Put the alert that fired in front of the trader behind the popup.
    this.accountPanel.selectTab("alerts")
    this.setFocus("account")
    this.alertPopup = new AlertPopup(this.renderer, {
      event,
      onDismiss: () => {
        this.closeAlertPopup()
        this.showNextAlert()
      },
      onRearm: () => {
        this.closeAlertPopup()
        void this.alertMonitor?.setStatus(event.alert.id, "ARMED").then(() => {
          if (!this.destroyed) this.showHintStatus(`${event.alert.displayName} alert re-armed.`, "#70d7a1", 3_000)
        })
        this.showNextAlert()
      },
    })
    this.root.add(this.alertPopup.root)
    this.renderer.requestRender()
  }

  private closeAlertPopup(): void {
    const popup = this.alertPopup
    if (!popup) return
    this.alertPopup = null
    if (!this.root.isDestroyed && !popup.root.isDestroyed) this.root.remove(popup.root)
    popup.destroy()
    this.renderer.requestRender()
  }

  /** ATR for the rule editor, read from the same candles the chart uses. */
  private async readAtr(instrumentUid: string, interval: CandleInterval): Promise<number | null> {
    const series = await this.options.candles.loadCandles(instrumentUid, rangeForInterval(interval), interval, {
      target: "INSTRUMENT",
    })
    return averageTrueRange(closedCandles(series, Date.now()))
  }

  private lastPriceFor(symbol: string): number | null {
    return this.instruments.find((instrument) => instrument.symbol === symbol)?.lastPrice
      ?? this.positions.find((position) => position.symbol === symbol)?.currentPrice
      ?? null
  }

  // The underlying's own last trade, for the overview digest. The depth tape is
  // the freshest source and is sorted newest first; its candles are the fallback,
  // and they already resolve to the underlying, so both legs price the same
  // instrument. The equity quote stream is not usable here — it only runs while
  // the chart is on the underlying.
  private underlyingLastPrice(...series: Array<CandleSeries | null>): number | null {
    const print = this.latestDepthBook?.trades[0]?.price
    if (print !== undefined) return print
    for (const candles of series) {
      const close = candles?.candles.at(-1)?.close
      if (close !== undefined) return close
    }
    return null
  }

  /**
   * Pushes what one contract costs onto the chart's OHLC line. The notional
   * moves with the price, so this runs on every tick for the selected contract
   * as well as when its details arrive.
   */
  private refreshContractCost(): void {
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    const details = this.contractDetails
    this.chart.setContractCost(instrument && details ? contractOrderCost(instrument, details) : null)
  }

  private scheduleOverviewGeneration(): void {
    if (!this.options.overview || this.destroyed) return
    if (this.overviewDebounce) clearTimeout(this.overviewDebounce)
    this.overviewDebounce = setTimeout(() => {
      this.overviewDebounce = null
      void this.generateOverview()
    }, this.options.overviewDebounceMs ?? OVERVIEW_DEBOUNCE_MS)
  }

  // The periodic refresh only spends a call while the figures still move. The
  // depth stream knows best; without it the flow distribution's own live flag
  // is the closest signal.
  private isMarketOpenForOverview(): boolean {
    if (this.latestDepthBook) return !this.latestDepthBook.marketClosed
    return this.brokerageLive
  }

  private ingestOverviewBook(book: DepthBook): void {
    if (book.symbol.toUpperCase() !== this.selectedEquitySymbol?.toUpperCase()) return
    this.latestDepthBook = book
    this.tradeFlow.ingest(book)
  }

  private async refreshOverviewConnection(): Promise<void> {
    const account = this.options.chatGptAccount
    if (!account || !this.options.overview) return
    try {
      const state = await account.getState()
      if (!this.destroyed) this.overviewPanel.setConnected(state !== null)
    } catch {
      // Unknown connection state renders as idle; the first run will surface it.
    }
  }

  // One overview run: read both flow sides and both custody readings for the
  // current range, digest them with the live book and tape, and only then let
  // the model phrase it. A rerun for an unchanged digest is skipped unless the
  // user forces it.
  private async generateOverview(options: { force?: boolean } = {}): Promise<void> {
    const generator = this.options.overview
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!generator || !instrument || !this.overviewEntitled || this.destroyed) return
    const mode = this.overviewPanel.activeMode
    this.overviewRequest?.abort()
    const request = new AbortController()
    this.overviewRequest = request
    const cached = this.overviewCache.get(overviewCacheKey(instrument.uid, mode))
    // The panel holds any review it already shows, so the progress is safe to
    // report even for a cached instrument.
    this.overviewPanel.setCollecting()
    try {
      const intraday = mode === "INTRADAY"
      const brokerage = this.brokerageEntitled ? this.options.brokerage : undefined
      // The custody register and the session candles each belong to one view;
      // the other view's run does not pay for them.
      const settlement = !intraday && this.settlementEntitled ? this.options.settlement : undefined
      const range = this.brokerageRange
      const signal = request.signal
      const [buyerFlow, sellerFlow, custodyGained, custodyLost, intradayCandles, dailyCandles] = await Promise.all([
        brokerage?.loadDistribution({ instrumentUid: instrument.uid, side: "BUYER", range, signal }) ?? null,
        brokerage?.loadDistribution({ instrumentUid: instrument.uid, side: "SELLER", range, signal }) ?? null,
        settlement?.loadSettlement({ instrumentUid: instrument.uid, mode: "GAINED", range, signal }) ?? null,
        settlement?.loadSettlement({ instrumentUid: instrument.uid, mode: "LOST", range, signal }) ?? null,
        intraday ? this.options.candles.loadCandles(instrument.uid, ...OVERVIEW_INTRADAY, { signal }) : null,
        this.options.candles.loadCandles(instrument.uid, ...OVERVIEW_DAILY, { signal }),
      ])
      if (this.destroyed || signal.aborted || this.overviewRequest !== request) return
      // Every feed above reads the underlying equity, so the digest is priced on
      // it too. A contract without an underlying is its own subject.
      const underlyingSymbol = instrument.underlyingSymbol
      const digest = buildOverviewDigest({
        mode,
        instrument: {
          symbol: underlyingSymbol ?? instrument.symbol,
          displayName: instrument.displayName,
          lastPrice: underlyingSymbol
            ? this.underlyingLastPrice(intradayCandles, dailyCandles)
            : instrument.lastPrice,
          contractSymbol: instrument.symbol,
          contractLastPrice: instrument.lastPrice,
        },
        book: this.latestDepthBook,
        tape: this.tradeFlow.snapshot(),
        buyerFlow,
        sellerFlow,
        custodyGained,
        custodyLost,
        intradayCandles,
        dailyCandles,
        range,
        presets: this.brokeragePresets,
      })
      if (!options.force && cached && isSameDigest(digest, cached.digest)) return
      this.overviewPanel.startStreaming()
      let commentary = ""
      await generator.generate(digest, {
        signal,
        onDelta: (text) => {
          commentary += text
          if (!this.destroyed && !signal.aborted && this.overviewRequest === request) {
            this.overviewPanel.appendCommentary(text)
          }
        },
      })
      if (this.destroyed || signal.aborted || this.overviewRequest !== request) return
      const snapshot: OverviewSnapshot = { digest, commentary, generatedAt: Date.now() }
      this.overviewCache.set(overviewCacheKey(instrument.uid, mode), snapshot)
      this.overviewPanel.finishCommentary()
      // Persisted after the panel settles: the reading is already usable, and a
      // failed write only costs the next launch its head start.
      void this.options.overviewSnapshots
        ?.put({ instrumentUid: instrument.uid, mode, ...snapshot })
        .catch((error: unknown) => this.reportError("AI overview cache", error))
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.overviewRequest !== request || isAbortError(error)) return
      if (this.reportError("AI overview", error)) return
      this.overviewPanel.showError(errorMessage(error))
    } finally {
      if (this.overviewRequest === request) this.overviewRequest = null
    }
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

  // Loads the contract's size and collateral, which is what prices one lot on
  // the chart's OHLC line. A background reload keeps it current while the
  // selection stays put, and a failed poll leaves the last good figures there.
  private async loadContractDetails(instrument: ViopInstrument): Promise<void> {
    const source = this.options.instruments
    if (!source.loadContractDetails) return
    this.contractDetailsRequest?.abort()
    const request = new AbortController()
    this.contractDetailsRequest = request
    try {
      const details = await source.loadContractDetails(instrument.uid, { signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.contractDetailsRequest !== request) return
      this.contractDetails = details
      this.refreshContractCost()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.contractDetailsRequest !== request || isAbortError(error)) return
      this.reportError("Contract details", error)
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
    // The account may have been connected or disconnected in the modal.
    void this.refreshOverviewConnection()
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
    const key = action === "cancel-orders" ? "c" : action === "exit-positions" ? "x" : "d"
    const description = action === "cancel-orders"
      ? "cancel all pending orders"
      : action === "exit-positions"
        ? "exit all open positions"
        : action === "delete-alert"
          ? "delete the selected price alert"
          : "delete the selected stop rule"
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
    if (this.newsContent && !this.newsContent.isDestroyed) this.newsSection.remove(this.newsContent)
    this.newsContent = node
    this.newsSection.add(node)
  }

  private toggleFocus(): void {
    const order: Focus[] = ["instruments", "portfolio", "chart", "depth", "brokers", "account", "news", "overview"]
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
    this.portfolioPanel.setFocused(this.focus === "portfolio")
    this.overviewPanel.setFocused(this.focus === "overview")
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
    const rightFocused = this.focus === "news" || this.focus === "overview"
    this.leftPanel.width = compact ? COMPACT_SIDEBAR_WIDTH : SIDEBAR_WIDTH
    this.centerPanel.visible = !compact || (!rightFocused && !depthFocused)
    this.depthColumn.visible = compact ? depthFocused : wide || depthFocused
    this.rightPanel.visible = compact ? rightFocused : wide || !depthFocused
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
      this.sortDirection = DEFAULT_SORT_DIRECTIONS[sort]
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
    for (const sort of INSTRUMENT_SORTS) {
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

// The row fills the sidebar's list column: the ticker on the left, the change
// hard against the right edge, and the price right-aligned in what is left. The
// two numbers therefore stay in one column each however wide the sidebar is set.
const INSTRUMENT_ROW_WIDTH = SIDEBAR_WIDTH - SIDEBAR_LIST_CHROME
const INSTRUMENT_NAME_WIDTH = 6
const INSTRUMENT_CHANGE_WIDTH = 7
const INSTRUMENT_PRICE_WIDTH =
  INSTRUMENT_ROW_WIDTH - INSTRUMENT_NAME_WIDTH - INSTRUMENT_CHANGE_WIDTH - 4

function formatInstrumentRow(instrument: ViopInstrument): string {
  const name = instrument.displayName.padEnd(INSTRUMENT_NAME_WIDTH)
  const price =
    instrument.lastPrice !== null
      ? instrument.lastPrice.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : ""
  const change =
    instrument.changePercent !== null
      ? `${instrument.changePercent >= 0 ? "+" : ""}${instrument.changePercent.toFixed(2)}%`
      : ""
  return `${name}  ${price.padStart(INSTRUMENT_PRICE_WIDTH)}  ${change.padStart(INSTRUMENT_CHANGE_WIDTH)}`
}

function instrumentComparator(sort: InstrumentSort, direction: SortDirection): (left: ViopInstrument, right: ViopInstrument) => number {
  return (left, right) => {
    // Ticker order is the one sort with no figure behind it, and it is also
    // what breaks every other sort's ties below.
    if (sort === "name") {
      const order = left.displayName.localeCompare(right.displayName, "tr")
      return direction === "desc" ? -order : order
    }
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

function overviewCacheKey(instrumentUid: string, mode: OverviewMode): string {
  return `${instrumentUid}:${mode}`
}

function isCapitalShortcut(key: KeyEvent, letter: "a" | "c" | "g" | "n" | "o" | "t" | "v"): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.sequence === letter.toUpperCase() || (key.shift && key.name === letter)
}

function isLowercaseShortcut(key: KeyEvent, letter: "c" | "x" | "d"): boolean {
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
