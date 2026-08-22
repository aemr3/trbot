import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  fg,
  isRenderable,
  link,
  t,
  type KeyEvent,
  type Renderable,
  type RenderContext,
} from "@opentui/core"
import { requiresAuthentication } from "@trbot/protocol/error.ts"
import type { StopOutcome } from "@trbot/protocol/stream.ts"
import { RemoteAlerts, RemoteStopRules } from "../remote-monitors.ts"
import { AccountPanel } from "../components/account-panel.ts"
import { BrokerageDateModal } from "../components/brokerage-date-modal.ts"
import { BrokeragePanel, brokerageSideOf, settlementModeOf } from "../components/brokerage-panel.ts"
import { CandlestickChart } from "../components/candlestick-chart.ts"
import { PortfolioPanel } from "../components/portfolio-panel.ts"
import { DepthPanel } from "../components/depth-panel.ts"
import { DOUBLE_CLICK_MS, SelectableList } from "../components/selectable-list.ts"
import { isShortcutHelpKey, ShortcutHelp, type ShortcutHelpSection } from "../components/shortcut-help.ts"
import { RenderCoalescer } from "../components/render-coalescer.ts"
import {
  WORKSPACE_CHROME_MUTED,
  WORKSPACE_CHROME_TEXT,
  workspaceChromeBackground,
} from "../components/workspace-chrome.ts"
import type { ApplicationLog } from "../logging/application-log.ts"
import {
  DEFAULT_BROKERAGE_RANGE,
  type BrokerageDatePreset,
  type BrokerageDateRange,
} from "@trbot/market/broker-calendar.ts"
import type { BrokerageDistributionSource, BrokerageSide } from "@trbot/market/brokerage.ts"
import {
  averageTrueRange,
  closedCandles,
  type CandleInterval,
  type CandleSource,
} from "@trbot/market/candle.ts"
import type { DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import {
  contractOrderCost,
  type ViopContractDetails,
  type ViopInstrument,
  type ViopInstrumentSource,
} from "@trbot/market/instrument.ts"
import type { NewsArticle, NewsSource } from "@trbot/market/news.ts"
import { isViopSessionScheduledOpen } from "@trbot/market/session.ts"
import { rangeForInterval, type StopRuleView, type StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"
import type { StopRule } from "@trbot/trading/stop.ts"
import type { AlertTriggerEvent, PriceAlertView } from "@trbot/market/alert-monitor.ts"
import type { PriceAlert } from "@trbot/market/alert.ts"
import type { SoundPlayer } from "../components/sound.ts"
import { AlertEditor } from "./alert-editor.ts"
import { AlertPopup } from "./alert-popup.ts"
import { StopRuleEditor } from "./stop-rule-editor.ts"
import { StopTriggerConfirmation } from "./stop-trigger-confirmation.ts"
import type { QuoteStream, QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { SettlementMode, SettlementSource } from "@trbot/market/settlement.ts"
import type { MemberFeatureSource } from "@trbot/member/features.ts"
import type { AccountPosition, AccountSource, AccountStream } from "@trbot/trading/account.ts"
import type {
  ViopOrderCancellationSource,
  ViopOrderSide,
  ViopOrderSource,
  ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { ViopOrderTicket } from "./order-ticket.ts"
import {
  DEFAULT_SORT_DIRECTIONS,
  DEFAULT_APP_PREFERENCES,
  INSTRUMENT_SORTS,
  TRADE_RIGHT_VIEWS,
  normalizeAppPreferences,
  type InstrumentSort,
  type SortDirection,
  type AppPreferences,
  type TradeRightView,
} from "@trbot/preferences/app.ts"

const UP_COLOR = TUI_THEME.positive
const DOWN_COLOR = TUI_THEME.negative
const NEUTRAL_COLOR = TUI_THEME.textNeutral
const SIDE_PANEL_BG = TUI_THEME.panelBackground
const SELECTED_ROW_BG = TUI_THEME.selection
const HEADER_COLOR = TUI_THEME.textPrimary
const FOCUSED_HEADER = TUI_THEME.textStrong
const UNFOCUSED_HEADER = TUI_THEME.textFaint
const LINK_COLOR = TUI_THEME.link
const NEWS_TIME_COLOR = TUI_THEME.newsTime
const NEWS_HEADLINE_COLOR = TUI_THEME.newsHeadline

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
const RIGHT_PANEL_BASE_WIDTH = 46
const CHART_WIDTH_TRANSFER_RATIO = 0.1
// What the instrument list spends on chrome rather than on a row: the sidebar's
// own padding, the list's selection indicator, its scrollbar gutter, and two
// columns of breathing room so the change column does not sit on the edge.
const SIDEBAR_LIST_CHROME = 8
const BROKERAGE_POLL_INTERVAL_MS = 60_000
const DEPTH_PANEL_BASIS = 19
const BROKERAGE_PANEL_BASIS = 9
const MARKET_CLOCK_INTERVAL_MS = 60_000
// The instrument list, depth ladder and news feed together claim 130 fixed
// columns, so the depth panel only joins them permanently once the chart and
// account column can still keep about 60. Below that it takes the news slot
// while it holds focus instead.
const DEPTH_LAYOUT_WIDTH = 190
// How often close-based and ATR stop rules re-read their candles. Anything
// finer just re-reads the same forming candle.
const SORT_LABELS = { change: "Change", volume: "Volume", name: "Name" } satisfies Record<InstrumentSort, string>
const RIGHT_VIEW_LABELS = { news: "News", chat: "Chat" } satisfies Record<TradeRightView, string>
const NEWS_FEEDS = ["instrument", "index"] as const
type NewsFeed = (typeof NEWS_FEEDS)[number]
type DestructiveAction = "cancel-orders" | "exit-positions" | "delete-stop" | "delete-alert"
const NEWS_FEED_LABELS = { instrument: "Stock", index: "Indices" } satisfies Record<NewsFeed, string>
const TRADE_HINT = "B/S trade · C chat · L logs · / ticker · ? help · Ctrl+C quit"
const TRADE_SHORTCUTS: ShortcutHelpSection[] = [
  {
    title: "Global",
    bindings: [
      { keys: "?", description: "Toggle this help" },
      { keys: "T / A / L", description: "Switch tab: trade, AI chat, logs" },
      { keys: "/", description: "Search and switch ticker" },
      { keys: "B / S", description: "Open buy / sell ticket" },
      { keys: "c c", description: "Cancel all pending VIOP orders" },
      { keys: "x x", description: "Exit all VIOP positions" },
      { keys: "Tab / Shift+Tab", description: "Move focus to the next / previous panel" },
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
      { keys: "%", description: "Sort by price change" },
      { keys: "V", description: "Sort by volume" },
      { keys: "N", description: "Sort by ticker" },
    ],
  },
  {
    title: "Chart",
    bindings: [
      { keys: "←/→ or h/l", description: "Change range" },
      { keys: "↑/↓ or j/k", description: "Change timeframe" },
      { keys: "Shift+←/→", description: "Scroll candle history" },
      { keys: "Shift+Home / End", description: "Jump to oldest / newest candles" },
      { keys: "Click", description: "Read a candle's OHLC; Esc releases it" },
      { keys: "f / F", description: "Cycle chart asset forwards / backwards" },
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
    title: "News and side chat",
    bindings: [
      { keys: "⌥N / ⌥C", description: "Show news / chat in the right panel" },
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

export interface TradeScreenOptions {
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
  stops?: RemoteStopRules
  stopCountdownMs?: number
  alerts?: RemoteAlerts
  sound?: SoundPlayer
  onSessionExpired?: () => void
  newsIntervalMs?: number
  instrumentIntervalMs?: number
  accountIntervalMs?: number
  brokerageIntervalMs?: number
  destructiveConfirmationTimeoutMs?: number
  preferences?: AppPreferences
  onPreferencesChange?: (preferences: AppPreferences) => void
  logs?: ApplicationLog
  manageInput?: boolean
  onMarketOpenChange?: (open: boolean) => void
  now?: () => Date
  marketClockIntervalMs?: number
  chat?: TradeChatPanel
}

/** Chat behavior mounted in the trade screen's right column. */
export interface TradeChatPanel {
  readonly root: BoxRenderable
  mount?(): void
  setModalHost?(host: BoxRenderable): void
  hasOpenModal?(): boolean
  activate(): void
  deactivate(): void
  capturesInput(): boolean
  canReleaseFocus(): boolean
  handleKey(key: KeyEvent): void
  openQuestion(sessionId: string): void
  openPermission(sessionId: string): void
  openSession(sessionId: string): void
  isShowingSession(sessionId: string): boolean
  setMarketOpen(open: boolean | null): void
  destroy(): void
}

type Focus = "instruments" | "portfolio" | "chart" | "depth" | "brokers" | "account" | "news"

export class TradeScreen {
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
  private readonly rightViewToolbar: BoxRenderable
  private readonly newsWorkspace: BoxRenderable
  private readonly newsSection: BoxRenderable
  private readonly viopHeader: TextRenderable
  private readonly rightViewButtons = new Map<TradeRightView, BoxRenderable>()
  private readonly rightViewButtonLabels = new Map<TradeRightView, TextRenderable>()
  private readonly newsFeedButtons = new Map<NewsFeed, BoxRenderable>()
  private readonly newsFeedButtonLabels = new Map<NewsFeed, TextRenderable>()
  private readonly newsList: SelectableList
  private readonly newsReader: ScrollBoxRenderable
  private readonly newsMessage: TextRenderable
  private readonly hint: TextRenderable
  private readonly footer: BoxRenderable
  private orderTicket: ViopOrderTicket | null = null
  private shortcutHelp: ShortcutHelp | null = null
  private tickerSearchQuery: string | null = null
  private tickerSearchMatchIndex = 0
  private pendingDestructiveAction: DestructiveAction | null = null

  private newsContent: Renderable | null = null
  private marketOpen: boolean
  private scheduledMarketOpen: boolean
  private providerMarketOpen: boolean | null = null
  private newsFeed: NewsFeed = "instrument"
  private rightView: TradeRightView
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
  // Held across a bulk exit whose outcome is unknown, so pressing again retries
  // that exit rather than sending a second set of orders. Cleared once the
  // server has answered. See the order ticket, which names an order the same way.
  private bulkExitKey: string | null = null
  private readerLastClickAt = 0
  private newsTimer: ReturnType<typeof setInterval> | null = null
  private instrumentTimer: ReturnType<typeof setInterval> | null = null
  private marketClockTimer: ReturnType<typeof setInterval> | null = null
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
  // Protective levels for open positions. The monitor watches prices; the
  // screen owns the confirmation and the order that follows it.
  private readonly stopMonitor: RemoteStopRules | null
  private pendingStopCountdownMs: number | null = null
  private pendingStopHeld = false
  private stopRuleEditor: StopRuleEditor | null = null
  private stopTrigger: StopTriggerConfirmation | null = null
  // Breaches waiting for the confirmation modal, so two levels reached at once
  // are answered one at a time instead of racing.
  private readonly stopTriggerQueue: StopTriggerEvent[] = []
  // Price levels the trader asked to be told about. Same watching, none of the
  // trading: a reached level rings and shows a notice, and that is all.
  private readonly alertMonitor: RemoteAlerts | null
  private alertEditor: AlertEditor | null = null
  private alertPopup: AlertPopup | null = null
  private readonly alertQueue: AlertTriggerEvent[] = []
  private positions: AccountPosition[] = []
  // Whether the account has ever answered. Until it has, an empty position list
  // means "not known yet", which is not the same as "nothing is open".
  private positionsKnown = false
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private destructiveConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private equityConnected = false
  private selectedEquitySymbol: string | null = null
  private preferences: AppPreferences
  private instrumentSort: InstrumentSort
  private sortDirection: SortDirection
  private readonly temporarilyNonSelectable: Renderable[] = []
  private readonly restoreSelectionAfterFinish = (): void => {
    queueMicrotask(() => this.restoreSelectionScope())
  }

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
    if (this.brokerageDateModal) {
      this.brokerageDateModal.handleKey(key)
      return
    }
    if (this.rightView === "chat" && this.options.chat?.hasOpenModal?.()) {
      this.options.chat.handleKey(key)
      return
    }
    if (isAltShortcut(key, "n")) {
      this.selectRightView("news")
      return
    }
    if (isAltShortcut(key, "c")) {
      this.selectRightView("chat")
      return
    }
    if (this.rightView === "chat" && this.focus === "news" && this.options.chat) {
      if ((key.name === "escape" || key.name === "esc") && this.options.chat.canReleaseFocus()) {
        this.setFocus("instruments")
        return
      }
      this.options.chat.handleKey(key)
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
    // Shift+Tab arrives as a shifted tab or as its own backtab key, depending on
    // the terminal; either way it walks the panels the other way.
    if (key.name === "tab" || key.name === "backtab") {
      this.moveFocus(key.shift || key.name === "backtab" ? -1 : 1)
      return
    }
    // The depth panel owns the key that switches which book it shows, and
    // swallows the rest rather than letting them reach the list behind it.
    if (this.focus === "depth") {
      this.depthPanel.handleKey(key)
      return
    }
    if (this.focus === "brokers") {
      this.brokeragePanel.handleKey(key)
      return
    }
    // The portfolio panel only owns its range keys; anything else falls through
    // to the instrument list, which is what the arrow keys mean everywhere else
    // in this column.
    if (this.focus === "portfolio" && this.portfolioPanel.handleKey(key)) return
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
    else if (key.sequence === "%") this.selectInstrumentSort("change")
    else if (isCapitalShortcut(key, "v")) this.selectInstrumentSort("volume")
    else if (isCapitalShortcut(key, "n")) this.selectInstrumentSort("name")
    else this.instrumentList.handleKey(key)
  }

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: TradeScreenOptions,
  ) {
    this.scheduledMarketOpen = isViopSessionScheduledOpen(this.now())
    this.marketOpen = this.scheduledMarketOpen
    this.preferences = normalizeAppPreferences(options.preferences ?? DEFAULT_APP_PREFERENCES)
    this.instrumentSort = this.preferences.instrumentSort
    this.sortDirection = this.preferences.sortDirection
    this.rightView = this.preferences.selectedTradeRightView === "chat" && !options.chat
      ? "news"
      : this.preferences.selectedTradeRightView
    if (this.rightView === "chat") this.focus = "news"

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      onSizeChange: () => this.updateResponsiveLayout(),
    })
    options.chat?.setModalHost?.(this.root)

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
    this.chartHeader = panelHeader(renderer, "Chart", { inline: true })
    this.chart = new CandlestickChart(renderer, {
      source: options.candles,
      initialRange: this.preferences.candleRange,
      initialInterval: this.preferences.candleInterval,
      initialTarget: this.preferences.chartTarget,
      initialIndicators: this.preferences.chartIndicators,
      onSelectionChange: (candleRange, candleInterval) => {
        this.savePreferences({ candleRange, candleInterval })
      },
      onIndicatorsChange: (chartIndicators) => this.savePreferences({ chartIndicators }),
      onTargetChange: (chartTarget) => {
        this.savePreferences({ chartTarget })
        this.syncChartQuoteSubscription()
        this.renderChartHeader()
      },
      onFocusRequest: () => this.setFocus("chart"),
      onError: (error) => this.reportError("Chart", error),
    })
    // Title and asset switches share one row; the switches keep their own
    // padding, so the title only needs a column of air before them.
    const chartHeaderRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      marginBottom: 1,
      overflow: "hidden",
    })
    this.chart.targetToolbar.marginLeft = 1
    chartHeaderRow.add(this.chartHeader)
    chartHeaderRow.add(this.chart.targetToolbar)
    this.centerPanel.add(chartHeaderRow)
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

    this.stopMonitor = options.stops ?? null
    this.stopMonitor?.onTrigger((event, remainingMs, held) => this.onStopTrigger(event, remainingMs, held))
    this.stopMonitor?.onChange(() => {
      this.accountPanel.showStopRules(this.stopMonitor?.views() ?? [])
      // Rules can protect contracts the watchlist does not carry, so a changed
      // rule list can widen what this screen needs quoted.
      this.syncQuoteSubscription()
    })
    this.stopMonitor?.onResolved((ruleId, outcome) => this.onStopResolved(ruleId, outcome))

    this.alertMonitor = options.alerts ?? null
    this.alertMonitor?.onTrigger((event) => this.onAlertTrigger(event))
    this.alertMonitor?.onChange(() => {
      this.accountPanel.showPriceAlerts(this.alertMonitor?.views() ?? [])
      this.syncQuoteSubscription()
    })

    // The order book and the broker distribution share one column: each keeps
    // the rows its fixed content needs and they split the remainder evenly.
    this.depthColumn = new BoxRenderable(renderer, { flexDirection: "column" })
    this.depthPanel = new DepthPanel(renderer, {
      initialTarget: this.preferences.depthTarget,
      onFocusRequest: () => this.setFocus("depth"),
      onTargetChange: (depthTarget) => {
        this.savePreferences({ depthTarget })
        this.syncDepthSubscription()
      },
    })
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
      width: RIGHT_PANEL_BASE_WIDTH,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
      onMouseDown: (event) => {
        if (event.button !== 0 || this.rightView !== "chat") return
        // OpenTUI auto-focuses the closest focusable node under the pointer after
        // mouse handlers run. A transcript click must keep the composer focused,
        // rather than replacing its visible cursor with the transcript scroller.
        event.preventDefault()
        this.setFocus("news")
        this.confineSelectionToChat()
      },
    })
    this.newsWorkspace = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
    })
    this.newsSection = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      flexGrow: 1,
    })
    this.rightViewToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
      gap: 1,
      marginBottom: 1,
    })
    for (const view of TRADE_RIGHT_VIEWS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.selectRightView(view)
        },
      })
      const label = new TextRenderable(renderer, { content: RIGHT_VIEW_LABELS[view], wrapMode: "none" })
      button.add(label)
      this.rightViewToolbar.add(button)
      this.rightViewButtons.set(view, button)
      this.rightViewButtonLabels.set(view, label)
    }
    this.rightPanel.add(this.rightViewToolbar)

    // Feed selection gets its own row so it reads as a control within News,
    // rather than as another peer of the News and Chat views.
    const newsFeedToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
      gap: 1,
      marginBottom: 1,
    })
    newsFeedToolbar.add(new TextRenderable(renderer, {
      content: "Feed",
      fg: NEUTRAL_COLOR,
      width: 5,
    }))
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
    this.newsMessage = new TextRenderable(renderer, { content: "Loading news…", fg: TUI_THEME.textSubdued })
    this.setNewsContent(this.newsMessage)
    this.newsWorkspace.add(this.newsSection)
    this.rightPanel.add(this.newsWorkspace)
    this.newsWorkspace.visible = this.rightView === "news"
    if (options.chat) {
      options.chat.root.visible = this.rightView === "chat"
      this.rightPanel.add(options.chat.root)
    }

    columns.add(this.leftPanel)
    columns.add(this.centerPanel)
    columns.add(this.depthColumn)
    columns.add(this.rightPanel)

    this.hint = new TextRenderable(renderer, {
      content: TRADE_HINT,
      fg: WORKSPACE_CHROME_MUTED,
      width: "100%",
    })
    this.footer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: workspaceChromeBackground(this.marketOpen),
    })
    this.footer.add(this.hint)

    this.root.add(columns)
    this.root.add(this.footer)

    this.options.quotes?.subscribe((update) => this.onQuote(update))
    this.options.quotes?.onConnectionChange((connected) => this.setConnected(connected))
    this.options.equityQuotes?.subscribe((update) => this.onEquityQuote(update))
    this.options.equityQuotes?.onConnectionChange((connected) => this.setEquityConnected(connected))
    this.options.depth?.subscribe((book) => {
      this.depthPanel.showBook(book)
    })
    this.options.depth?.onStatusChange((status) => this.depthPanel.setStatus(status))
  }

  mount(): void {
    if (this.options.manageInput !== false) this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.options.chat?.mount?.()
    this.options.chat?.deactivate()
    this.updateFocusIndicator()
    this.accountPanel.mount()
    void this.load()
    void this.loadMemberFeatures()
    void this.loadStopRules()
    void this.loadPriceAlerts()
    this.options.onMarketOpenChange?.(this.marketOpen)
    this.marketClockTimer = setInterval(
      () => this.refreshMarketClock(),
      this.options.marketClockIntervalMs ?? MARKET_CLOCK_INTERVAL_MS,
    )
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
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.restoreSelectionScope()
    this.listResort.cancel()
    this.chart.destroy()
    this.accountPanel.destroy()
    this.tickerSearchQuery = null
    this.closeShortcutHelp()
    this.closeOrderTicket()
    this.closeStopRuleEditor()
    this.closeStopTrigger()
    this.closeAlertEditor()
    this.closeAlertPopup()
    this.options.chat?.destroy()
    this.stopMonitor?.destroy()
    this.alertMonitor?.destroy()
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
    if (this.marketClockTimer) {
      clearInterval(this.marketClockTimer)
      this.marketClockTimer = null
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

  /** Keeps a drag that began in embedded chat from collecting sibling panel text. */
  private confineSelectionToChat(): void {
    const chatRoot = this.options.chat?.root
    if (!chatRoot || !this.renderer.getSelection()?.isDragging || this.temporarilyNonSelectable.length > 0) return

    this.disableSelectionOutside(this.root, chatRoot)
    this.renderer.once("selection", this.restoreSelectionAfterFinish)
  }

  private disableSelectionOutside(renderable: Renderable, allowed: Renderable): void {
    if (renderable === allowed) return
    if (renderable.selectable) {
      renderable.selectable = false
      this.temporarilyNonSelectable.push(renderable)
    }
    for (const child of renderable.getChildren()) {
      if (isRenderable(child)) this.disableSelectionOutside(child, allowed)
    }
  }

  private restoreSelectionScope(): void {
    this.renderer.off("selection", this.restoreSelectionAfterFinish)
    for (const renderable of this.temporarilyNonSelectable.splice(0)) {
      if (!renderable.isDestroyed) renderable.selectable = true
    }
  }

  /**
   * Whether a key typed now belongs to something on this screen rather than to
   * the tab bar. True while anything with a field or a confirmation is up: the
   * ticker search takes letters, and a modal in front of the panels owns Escape.
   */
  capturesInput(): boolean {
    return (this.rightView === "chat" && this.focus === "news" && (this.options.chat?.capturesInput() ?? false))
      || this.tickerSearchQuery !== null
      || this.orderTicket !== null
      || this.shortcutHelp !== null
      || this.brokerageDateModal !== null
      || this.stopRuleEditor !== null
      || this.stopTrigger !== null
      || this.alertEditor !== null
      || this.alertPopup !== null
      || this.articleOpen
  }

  handleKey(key: KeyEvent): void {
    this.handleKeypress(key)
  }

  activate(): void {
    if (this.rightView === "chat" && this.focus === "news") this.options.chat?.activate()
  }

  deactivate(): void {
    this.options.chat?.deactivate()
  }

  isShowingSession(sessionId: string): boolean {
    return this.rightView === "chat" && this.options.chat?.isShowingSession(sessionId) === true
  }

  hasEmbeddedChat(): boolean {
    return this.options.chat !== undefined
  }

  openQuestion(sessionId: string): void {
    if (!this.options.chat) return
    this.selectRightView("chat")
    this.options.chat.openQuestion(sessionId)
  }

  openPermission(sessionId: string): void {
    if (!this.options.chat) return
    this.selectRightView("chat")
    this.options.chat.openPermission(sessionId)
  }

  openSession(sessionId: string): void {
    if (!this.options.chat) return
    this.selectRightView("chat")
    this.options.chat.openSession(sessionId)
  }

  setMarketOpen(open: boolean | null): void {
    this.options.chat?.setMarketOpen(open)
    if (this.destroyed || open === null || this.marketOpen === open) return
    this.marketOpen = open
    this.footer.backgroundColor = workspaceChromeBackground(open)
    this.renderer.requestRender()
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
      this.chartHeader.fg = TUI_THEME.negative
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
    } catch (error) {
      if (this.destroyed || request.signal.aborted || isAbortError(error)) return
      this.reportError("Member features", error)
      this.setDepthEntitled(false)
      this.setBrokerageEntitled(false)
      this.setSettlementEntitled(false)
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
      if (!background) this.brokeragePanel.showMessage(`Failed to load: ${errorMessage(error)}`, TUI_THEME.negative)
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
      if (!background) this.brokeragePanel.showMessage(`Failed to load: ${errorMessage(error)}`, TUI_THEME.negative)
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
      this.showHintStatus("The broker calendar has not loaded yet.", TUI_THEME.warning, 3_000)
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

  // Both books exist: the market data feed serves one for the stock and one for
  // the contract written on it, so the panel follows whichever the trader picked.
  private syncDepthSubscription(): void {
    const depth = this.options.depth
    if (!depth) return
    const symbol = this.depthEntitled ? this.depthPanel.activeSymbol() : null
    if (symbol) depth.start(symbol)
    else depth.stop()
  }

  // Applies a live price tick in place. The stream carries only the traded
  // price, so the daily change is re-derived against the session's reference
  // close, which the snapshot poll keeps current across trading days.
  private onQuote(update: QuoteUpdate): void {
    if (this.destroyed) return
    if (update.symbol === this.instruments[this.instrumentList.selectedIndex]?.symbol) {
      this.acceptSessionStatus(update.sessionStatus)
    }
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
    this.refreshMarketClock(true)
    this.syncChartQuoteSubscription()
    this.depthPanel.selectInstrument({
      displayName: instrument.displayName,
      symbol: instrument.symbol,
      underlyingSymbol: instrument.underlyingSymbol,
    })
    this.syncDepthSubscription()
    this.brokeragePanel.reset()
    this.loadBrokerView()
    this.renderChartHeader()
    void this.loadNews(instrument)
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
      this.showHintStatus("Stop rules need a database; none is configured.", TUI_THEME.warning, 4_000)
      return
    }
    if (this.positions.length === 0) {
      this.showHintStatus("No open VIOP positions to protect.", TUI_THEME.textMuted, 3_000)
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
          this.showHintStatus(`${draft.role === "STOP" ? "Stop" : "Target"} armed for ${draft.displayName}.`, TUI_THEME.positive, 4_000)
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
      this.showHintStatus("This rule already triggered; edit it to arm a new level.", TUI_THEME.warning, 4_000)
      return
    }
    const armed = view.rule.status === "ARMED"
    await monitor.setStatus(view.rule.id, armed ? "PAUSED" : "ARMED")
    if (this.destroyed) return
    this.showHintStatus(`${view.rule.displayName} ${armed ? "paused" : "armed"}.`, TUI_THEME.textMuted, 3_000)
  }

  private async deleteSelectedStopRule(): Promise<void> {
    const monitor = this.stopMonitor
    const view = this.accountPanel.selectedStop()
    if (!monitor || !view) return
    await monitor.removeRule(view.rule.id)
    if (this.destroyed) return
    this.syncQuoteSubscription()
    this.showHintStatus(`Deleted the ${view.rule.role === "STOP" ? "stop" : "target"} on ${view.rule.displayName}.`, TUI_THEME.textMuted, 3_000)
  }

  /**
   * A level was reached. Nothing is sent yet: the trader sees what the exit
   * would be and either lets the countdown run or stops it.
   */
  private onStopTrigger(event: StopTriggerEvent, remainingMs: number, held: boolean): void {
    // A repeat of a rule already queued or on screen is the server refreshing
    // its countdown, not a second trigger.
    if (this.stopTrigger?.ruleId === event.rule.id) return
    if (this.stopTriggerQueue.some((queued) => queued.rule.id === event.rule.id)) return
    this.stopTriggerQueue.push(event)
    this.pendingStopCountdownMs = remainingMs
    this.pendingStopHeld = held
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
      // The server owns the real countdown; this mirrors what it reported so the
      // trader sees the same clock.
      countdownMs: this.pendingStopCountdownMs ?? this.options.stopCountdownMs,
      held: this.pendingStopHeld,
      onHoldChange: (held) => {
        const decision = held ? this.stopMonitor?.hold(event.rule.id) : this.stopMonitor?.release(event.rule.id)
        void decision?.catch((cause: unknown) => {
          if (this.destroyed) return
          // The clock the trader sees is now not the clock the server is
          // running, which they need to know before it runs out.
          this.reportError("Stop decision", cause)
          this.showHintStatus(
            `Could not ${held ? "hold" : "release"} the ${event.rule.displayName} stop: ${errorMessage(cause)}`,
            TUI_THEME.negative,
            6_000,
          )
        })
      },
      onConfirm: () => void this.submitStopExit(event),
      onCancel: () => void this.standDownStop(event),
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
  /**
   * Sends the exit now instead of waiting out the server's countdown. The server
   * places the order — the terminal never does — and reports back through
   * `onResolved`, so a trader who closes the terminal mid-countdown still gets
   * the exit.
   */
  private async submitStopExit(event: StopTriggerEvent): Promise<void> {
    if (this.destroyed) return
    this.showHintStatus(`Submitting the ${event.rule.displayName} exit…`, TUI_THEME.warning)
    this.closeStopTrigger()
    this.showNextStopTrigger()
    try {
      await this.stopMonitor?.confirm(event.rule.id)
    } catch (error) {
      if (this.destroyed) return
      this.reportError("Stop decision", error)
      // The countdown is still running on the server, so this is a delay rather
      // than a cancellation — and saying nothing would imply the exit went out.
      this.showHintStatus(
        `Could not send the ${event.rule.displayName} exit now: ${errorMessage(error)}`,
        TUI_THEME.negative,
        6_000,
      )
    }
  }

  /**
   * Stands a fired stop down, and only says so once the server agrees.
   *
   * The countdown belongs to the server. Closing the modal and reporting "no
   * order sent" without an acknowledgement is how a trader stops watching a stop
   * that then exits their position anyway.
   */
  private async standDownStop(event: StopTriggerEvent): Promise<void> {
    this.closeStopTrigger()
    try {
      await this.stopMonitor?.cancel(event.rule.id)
      if (this.destroyed) return
      this.showHintStatus(`Stood down the ${event.rule.displayName} stop; no order sent.`, TUI_THEME.warning, 4_000)
    } catch (error) {
      if (this.destroyed) return
      this.reportError("Stop decision", error)
      this.showHintStatus(
        `Could not stand down the ${event.rule.displayName} stop — its countdown is still running: ${errorMessage(error)}`,
        TUI_THEME.negative,
        8_000,
      )
    } finally {
      if (!this.destroyed) this.showNextStopTrigger()
    }
  }

  private onStopResolved(ruleId: string, outcome: StopOutcome): void {
    if (this.destroyed) return
    const rule = this.stopMonitor?.rule(ruleId)
    const name = rule?.displayName ?? "stop"
    if (outcome === "SUBMITTED") {
      void this.accountPanel.refresh()
      this.showHintStatus(`Exited on the ${name} ${rule?.role === "TARGET" ? "target" : "stop"}.`, TUI_THEME.positive, 4_000)
      return
    }
    if (outcome === "FAILED") {
      // The rule stays triggered: nothing was closed, and it must not look done.
      this.showHintStatus(`The ${name} exit failed; nothing was closed.`, TUI_THEME.negative, 6_000)
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
  }

  private openAlertEditor(alert?: PriceAlert): void {
    if (this.destroyed || this.alertEditor) return
    if (!this.alertMonitor) {
      this.showHintStatus("Price alerts need a database; none is configured.", TUI_THEME.warning, 4_000)
      return
    }
    if (this.instruments.length === 0) {
      this.showHintStatus("No contracts to watch yet.", TUI_THEME.textMuted, 3_000)
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
          this.showHintStatus(
            `Alert set on ${draft.displayName} ${draft.direction === "ABOVE" ? "above" : "below"} the level.`,
            TUI_THEME.positive,
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
    this.showHintStatus(`${view.alert.displayName} alert ${armed ? "paused" : "armed"}.`, TUI_THEME.textMuted, 3_000)
  }

  private async deleteSelectedAlert(): Promise<void> {
    const monitor = this.alertMonitor
    const view = this.accountPanel.selectedAlert()
    if (!monitor || !view) return
    await monitor.removeAlert(view.alert.id)
    if (this.destroyed) return
    this.syncQuoteSubscription()
    this.showHintStatus(`Deleted the ${view.alert.displayName} alert.`, TUI_THEME.textMuted, 3_000)
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
        // The server keeps a fired alert outstanding until a client answers it,
        // and replays what is outstanding to whoever attaches. Closing only the
        // popup means the next reconnect rings for it again.
        this.alertMonitor?.dismiss(event.alert.id)
        this.closeAlertPopup()
        this.showNextAlert()
      },
      onRearm: () => {
        this.closeAlertPopup()
        void this.alertMonitor?.setStatus(event.alert.id, "ARMED").then(() => {
          if (!this.destroyed) this.showHintStatus(`${event.alert.displayName} alert re-armed.`, TUI_THEME.positive, 3_000)
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

  private acceptSessionStatus(status: string | null): void {
    if (!status) return
    const normalized = status.toUpperCase()
    if (normalized === "OPEN") this.providerMarketOpen = true
    else if (normalized === "CLOSED") this.providerMarketOpen = false
    else return
    this.updateMarketOpen(this.scheduledMarketOpen && this.providerMarketOpen === true)
  }

  private refreshMarketClock(resetProvider = false): void {
    const scheduled = isViopSessionScheduledOpen(this.now())
    if (resetProvider) this.providerMarketOpen = null
    if (scheduled === this.scheduledMarketOpen && !resetProvider) return
    // A new scheduled session needs a fresh answer from the provider. Until it
    // arrives, the clock is the fallback rather than yesterday's closed state.
    if (scheduled) this.providerMarketOpen = null
    this.scheduledMarketOpen = scheduled
    this.updateMarketOpen(scheduled && this.providerMarketOpen !== false)
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private updateMarketOpen(open: boolean): void {
    if (this.marketOpen === open) return
    this.setMarketOpen(open)
    this.options.onMarketOpenChange?.(open)
  }

  private selectPositionInstrument(instrumentUid: string, symbol: string): void {
    const index = this.instruments.findIndex(
      (instrument) => instrument.uid === instrumentUid || instrument.symbol === symbol,
    )
    if (index < 0) {
      this.showHintStatus(`Position contract ${symbol} is not in the watchlist.`, TUI_THEME.warning, 4_000)
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
    this.setMessage("Loading news…", TUI_THEME.textSubdued)
    try {
      const articles = await this.options.news.listNews(feed === "index" ? {} : { instrumentUid: instrument.uid })
      if (this.destroyed || this.newsFeed !== feed || this.newsRequestUid !== requestKey) return
      this.renderNews(articles, feed === "index" ? "BIST indices" : instrument.displayName)
    } catch (error) {
      if (this.destroyed || this.newsFeed !== feed || this.newsRequestUid !== requestKey) return
      if (this.reportError("News", error)) return
      this.setMessage(`Failed to load news: ${errorMessage(error)}`, TUI_THEME.negative)
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
      sections: TRADE_SHORTCUTS,
      onClose: () => this.closeShortcutHelp(),
    })
    this.shortcutHelp = help
    this.root.add(help.root)
    this.renderer.requestRender()
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
    this.hint.content = TRADE_HINT
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
    this.showHintStatus(`Press ${key} again to ${description}.`, TUI_THEME.warning)
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
    this.hint.content = TRADE_HINT
    this.hint.fg = WORKSPACE_CHROME_MUTED
    this.renderer.requestRender()
  }

  private async cancelAllPendingOrders(): Promise<void> {
    const source = this.options.orderCancellation
    if (!source || this.tradingActionRequest || this.destroyed) return
    const request = new AbortController()
    this.tradingActionRequest = request
    this.showHintStatus("Loading pending VIOP orders…", TUI_THEME.warning)
    try {
      const orders = await source.listPendingOrders({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (orders.length === 0) {
        this.showHintStatus("No pending VIOP orders to cancel.", TUI_THEME.textMuted, 3_000)
        return
      }
      this.showHintStatus(`Cancelling ${orders.length} pending VIOP order${orders.length === 1 ? "" : "s"}…`, TUI_THEME.warning)
      const result = await source.cancelPendingOrders({
        orderUids: orders.map((order) => order.uid),
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (result.cancelledOrderUids.length > 0) void this.accountPanel.refresh()
      if (result.failures.length === 0) {
        const count = result.cancelledOrderUids.length
        this.showHintStatus(`Cancelled ${count} pending VIOP order${count === 1 ? "" : "s"}.`, TUI_THEME.positive, 4_000)
      } else {
        const message = result.failures[0]?.message ?? "Cancellation failed"
        this.showHintStatus(
          `Cancelled ${result.cancelledOrderUids.length}; ${result.failures.length} failed: ${message}`,
          TUI_THEME.negative,
          6_000,
        )
      }
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request || isAbortError(error)) return
      if (this.reportError("Order cancellation", error)) return
      this.showHintStatus(`Failed to cancel pending orders: ${errorMessage(error)}`, TUI_THEME.negative, 6_000)
    } finally {
      if (this.tradingActionRequest === request) this.tradingActionRequest = null
    }
  }

  private async exitAllPositions(): Promise<void> {
    const source = this.options.positionExit
    if (!source || this.tradingActionRequest || this.destroyed) return
    const request = new AbortController()
    this.tradingActionRequest = request
    this.showHintStatus("Submitting simulated-market VIOP exits…", TUI_THEME.warning)
    // Names the exit the trader is trying to send, not the call that carries it.
    this.bulkExitKey ??= crypto.randomUUID()
    try {
      const result = await source.exitAllPositions({
        signal: request.signal,
        idempotencyKey: this.bulkExitKey,
      })
      // The server answered, so this exit is settled either way and pressing
      // again is a new one — over positions opened since, most likely.
      this.bulkExitKey = null
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request) return
      if (result.submitted.length > 0) void this.accountPanel.refresh()
      if (result.submitted.length === 0 && result.failures.length === 0) {
        this.showHintStatus("No open VIOP positions to exit.", TUI_THEME.textMuted, 3_000)
      } else if (result.failures.length === 0) {
        const count = result.submitted.length
        this.showHintStatus(`Submitted exit orders for ${count} VIOP position${count === 1 ? "" : "s"}.`, TUI_THEME.positive, 4_000)
      } else {
        const message = result.failures[0]?.message ?? "Position exit failed"
        this.showHintStatus(
          `Submitted ${result.submitted.length} exits; ${result.failures.length} failed: ${message}`,
          TUI_THEME.negative,
          6_000,
        )
      }
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.tradingActionRequest !== request || isAbortError(error)) return
      if (this.reportError("Position exit", error)) return
      this.showHintStatus(`Failed to exit positions: ${errorMessage(error)}`, TUI_THEME.negative, 6_000)
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
      this.hint.content = TRADE_HINT
      this.hint.fg = WORKSPACE_CHROME_MUTED
    }, resetAfterMs)
  }

  private renderNews(articles: NewsArticle[], label: string): void {
    // A refresh keeps the cursor on the story it is on, since a new headline arriving
    // shifts every row down; a story that is gone, or another symbol's feed, starts at
    // the newest.
    const highlighted = this.newsArticles[this.newsList.selectedIndex]?.uid
    this.newsArticles = articles
    if (articles.length === 0) {
      this.setMessage(`No recent news for ${label}.`, TUI_THEME.textSubdued)
      return
    }
    this.newsList.setRows(
      articles.map((article) => ({ id: article.uid, content: newsRowContent(article) })),
      highlighted ?? articles[0]?.uid,
    )
    this.setNewsContent(this.newsList.root)
  }

  private async openArticle(index: number): Promise<void> {
    const article = this.newsArticles[index]
    if (!article) return
    this.articleOpen = true
    this.articleRequestUid = article.uid
    this.renderReaderMessage("Loading article…", TUI_THEME.textSubdued)
    this.setNewsContent(this.newsReader)
    try {
      const full = await this.options.news.getArticle(article.uid)
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      this.renderReader(full ?? article)
    } catch (error) {
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      if (this.reportError("News article", error)) return
      this.renderReaderMessage(`Failed to load article: ${errorMessage(error)}`, TUI_THEME.negative)
    }
  }

  private notifyIfSessionExpired(cause: unknown): boolean {
    if (!requiresAuthentication(cause)) return false
    if (!this.sessionExpiredNotified) {
      this.sessionExpiredNotified = true
      this.options.onSessionExpired?.()
    }
    return true
  }

  private reportError(scope: string, cause: unknown): boolean {
    this.options.logs?.error(scope, cause)
    return this.notifyIfSessionExpired(cause)
  }

  private closeArticle(): void {
    this.articleOpen = false
    this.articleRequestUid = null
    this.setNewsContent(this.newsList.root)
  }

  private renderReader(article: NewsArticle): void {
    for (const child of this.newsReader.getChildren()) this.newsReader.remove(child)
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.headline, fg: TUI_THEME.textStrong, wrapMode: "word", width: "100%" }))
    if (article.tag) this.newsReader.add(new TextRenderable(this.renderer, { content: article.tag, fg: TUI_THEME.textMuted }))
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.body || "(No content)", fg: TUI_THEME.textBody, wrapMode: "word", width: "100%" }))

    const links = [article.url, ...article.attachments].filter((url): url is string => Boolean(url))
    if (links.length > 0) {
      this.newsReader.add(new TextRenderable(this.renderer, { content: "Bağlantı:", fg: TUI_THEME.textMuted }))
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

  private moveFocus(direction: 1 | -1): void {
    const order: Focus[] = ["instruments", "portfolio", "chart", "depth", "brokers", "account", "news"]
    const index = order.indexOf(this.focus)
    const next = (index + direction + order.length) % order.length
    this.setFocus(order[next] ?? "instruments")
  }

  private setFocus(focus: Focus): void {
    if (this.focus === focus) {
      if (focus === "news" && this.rightView === "chat") this.options.chat?.activate()
      return
    }
    const leavingChat = this.focus === "news" && this.rightView === "chat"
    this.focus = focus
    if (leavingChat) this.options.chat?.deactivate()
    if (focus === "news" && this.rightView === "chat") this.options.chat?.activate()
    this.updateFocusIndicator()
  }

  private selectRightView(view: TradeRightView): void {
    if (view === "chat" && !this.options.chat) return
    if (this.rightView === view) {
      this.setFocus("news")
      return
    }
    this.options.chat?.deactivate()
    this.rightView = view
    this.savePreferences({ selectedTradeRightView: view })
    this.setFocus("news")
    this.newsWorkspace.visible = view === "news"
    if (this.options.chat) this.options.chat.root.visible = view === "chat"
    if (view === "chat") this.options.chat!.activate()
    this.paintNewsToolbar()
    this.renderer.requestRender()
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
    this.paintNewsToolbar()
    this.updateResponsiveLayout()
  }

  private paintNewsFeedToolbar(): void {
    for (const feed of NEWS_FEEDS) {
      const selected = this.newsFeed === feed
      const button = this.newsFeedButtons.get(feed)
      const label = this.newsFeedButtonLabels.get(feed)
      if (!button || !label) continue
      button.visible = this.rightView === "news"
      button.backgroundColor = selected ? SELECTED_ROW_BG : undefined
      label.fg = selected ? TUI_THEME.textStrong : this.focus === "news" ? TUI_THEME.textSecondary : TUI_THEME.textFaint
    }
  }

  private paintNewsToolbar(): void {
    this.rightViewToolbar.marginBottom = this.rightView === "news" ? 1 : 0
    for (const view of TRADE_RIGHT_VIEWS) {
      const selected = this.rightView === view
      const button = this.rightViewButtons.get(view)
      const label = this.rightViewButtonLabels.get(view)
      if (!button || !label) continue
      button.backgroundColor = selected ? SELECTED_ROW_BG : undefined
      label.fg = selected
        ? TUI_THEME.textStrong
        : this.focus === "news" ? TUI_THEME.textSecondary : TUI_THEME.textFaint
    }
    this.paintNewsFeedToolbar()
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
    const rightFocused = this.focus === "news"
    const depthVisible = compact ? depthFocused : wide || depthFocused
    this.leftPanel.width = compact ? COMPACT_SIDEBAR_WIDTH : SIDEBAR_WIDTH
    this.centerPanel.visible = !compact || (!rightFocused && !depthFocused)
    this.depthColumn.visible = depthVisible
    this.rightPanel.visible = compact ? rightFocused : wide || !depthFocused
    this.depthColumn.width = compact ? "auto" : DEPTH_PANEL_WIDTH
    this.depthColumn.flexGrow = compact ? 1 : 0
    if (compact) {
      this.rightPanel.width = "auto"
    } else {
      const fixedWidth = SIDEBAR_WIDTH + RIGHT_PANEL_BASE_WIDTH + (depthVisible ? DEPTH_PANEL_WIDTH : 0)
      const originalCenterWidth = Math.max(0, this.root.width - fixedWidth)
      this.rightPanel.width = RIGHT_PANEL_BASE_WIDTH
        + Math.round(originalCenterWidth * CHART_WIDTH_TRANSFER_RATIO)
    }
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

  private savePreferences(update: Partial<AppPreferences>): void {
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
      label.fg = active ? HEADER_COLOR : this.focus === "instruments" ? TUI_THEME.textSecondary : UNFOCUSED_HEADER
    }
  }
}

function newsRowContent(article: NewsArticle) {
  if (!article.tag) return t`${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
  return t`${fg(NEWS_TIME_COLOR)(article.tag)}\n${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
}

function panelHeader(renderer: RenderContext, title: string, options: { inline?: boolean } = {}): TextRenderable {
  const header = new TextRenderable(renderer, {
    content: title,
    fg: HEADER_COLOR,
    marginBottom: 1,
  })
  // An inline header shares its row with controls: the row owns the trailing
  // blank line, and the title never gives up columns to what sits beside it.
  if (options.inline) {
    header.marginBottom = 0
    header.flexShrink = 0
  }
  return header
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

function isCapitalShortcut(key: KeyEvent, letter: "a" | "c" | "g" | "n" | "t" | "v"): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.sequence === letter.toUpperCase() || (key.shift && key.name === letter)
}

function isAltShortcut(key: KeyEvent, letter: "c" | "n"): boolean {
  return Boolean(key.meta || key.option) && !key.ctrl && key.name === letter
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError"
}
