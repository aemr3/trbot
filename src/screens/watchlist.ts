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
import { CredentialsRequiredError } from "../api/index.ts"
import { AccountPanel } from "../components/account-panel.ts"
import { CandlestickChart } from "../components/candlestick-chart.ts"
import { ContractDetailsPanel } from "../components/contract-details-panel.ts"
import { DOUBLE_CLICK_MS, SelectableList } from "../components/selectable-list.ts"
import { isShortcutHelpKey, ShortcutHelp, type ShortcutHelpSection } from "../components/shortcut-help.ts"
import type { CandleSource } from "../market/candle.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "../market/equity-quote-stream.ts"
import type { ViopInstrument, ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsArticle, NewsSource } from "../market/news.ts"
import type { QuoteStream, QuoteUpdate } from "../market/quote-stream.ts"
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
const COMPACT_LAYOUT_WIDTH = 104
const SORT_LABELS = { change: "Change", volume: "Volume" } as const
const WATCHLIST_HINT = "B/S trade · / ticker · c cancel · x exit · ? help · Ctrl+C quit"
const WATCHLIST_SHORTCUTS: ShortcutHelpSection[] = [
  {
    title: "Global",
    bindings: [
      { keys: "?", description: "Toggle this help" },
      { keys: "/", description: "Search and switch ticker" },
      { keys: "B / S", description: "Open buy / sell ticket" },
      { keys: "c", description: "Cancel all pending VIOP orders" },
      { keys: "x", description: "Exit all VIOP positions" },
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
  onSessionExpired?: () => void
  newsIntervalMs?: number
  instrumentIntervalMs?: number
  accountIntervalMs?: number
  preferences?: WatchlistPreferences
  onPreferencesChange?: (preferences: WatchlistPreferences) => void
}

type Focus = "instruments" | "chart" | "account" | "news"

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
  private readonly rightPanel: BoxRenderable
  private readonly viopHeader: TextRenderable
  private readonly newsHeader: TextRenderable
  private readonly newsList: SelectableList
  private readonly newsReader: ScrollBoxRenderable
  private readonly newsMessage: TextRenderable
  private readonly hint: TextRenderable
  private orderTicket: ViopOrderTicket | null = null
  private shortcutHelp: ShortcutHelp | null = null
  private tickerSearchQuery: string | null = null
  private tickerSearchMatchIndex = 0

  private newsContent: Renderable | null = null
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
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private equityConnected = false
  private selectedEquitySymbol: string | null = null
  private preferences: WatchlistPreferences
  private instrumentSort: InstrumentSort
  private sortDirection: SortDirection

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (this.tickerSearchQuery !== null) {
      this.handleTickerSearchKey(key)
      return
    }
    if (this.shortcutHelp) {
      this.shortcutHelp.handleKey(key)
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
    if (isLowercaseShortcut(key, "c")) {
      void this.cancelAllPendingOrders()
      return
    }
    if (isLowercaseShortcut(key, "x")) {
      void this.exitAllPositions()
      return
    }
    if (key.name === "tab") {
      this.toggleFocus()
      return
    }
    if (this.focus === "news") this.newsList.handleKey(key)
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
      onSelectionChange: (candleRange, candleInterval) => {
        this.savePreferences({ candleRange, candleInterval })
      },
      onFocusRequest: () => this.setFocus("chart"),
      onError: (error) => this.notifyIfSessionExpired(error),
    })
    this.centerPanel.add(this.chart.root)
    this.accountPanel = new AccountPanel(renderer, {
      source: options.account,
      stream: options.accountStream,
      refreshIntervalMs: options.accountIntervalMs,
      onFocusRequest: () => this.setFocus("account"),
      onPositionSelect: (position) => this.selectPositionInstrument(position.uid, position.symbol),
      onError: (error) => this.notifyIfSessionExpired(error),
    })
    this.centerPanel.add(this.accountPanel.root)

    this.rightPanel = new BoxRenderable(renderer, {
      width: 46,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    this.newsHeader = panelHeader(renderer, "News")
    this.rightPanel.add(this.newsHeader)
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
    columns.add(this.rightPanel)

    this.hint = new TextRenderable(renderer, {
      content: WATCHLIST_HINT,
      fg: "#777777",
    })

    this.root.add(columns)
    this.root.add(this.hint)

    this.options.quotes?.subscribe((update) => this.onQuote(update))
    this.options.quotes?.onConnectionChange((connected) => this.setConnected(connected))
    this.options.equityQuotes?.subscribe((update) => this.onEquityQuote(update))
    this.options.equityQuotes?.onConnectionChange((connected) => this.setEquityConnected(connected))
  }

  mount(): void {
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.updateFocusIndicator()
    this.accountPanel.mount()
    void this.load()
    this.newsTimer = setInterval(() => void this.refreshNews(), this.options.newsIntervalMs ?? NEWS_POLL_INTERVAL_MS)
    this.instrumentTimer = setInterval(
      () => void this.refreshInstrumentVolumes(),
      this.options.instrumentIntervalMs ?? INSTRUMENT_POLL_INTERVAL_MS,
    )
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.chart.destroy()
    this.accountPanel.destroy()
    this.tickerSearchQuery = null
    this.closeShortcutHelp()
    this.closeOrderTicket()
    this.contractDetailsRequest?.abort()
    this.contractDetailsRequest = null
    this.tradingActionRequest?.abort()
    this.tradingActionRequest = null
    this.instrumentRefreshRequest?.abort()
    this.instrumentRefreshRequest = null
    this.options.quotes?.stop()
    this.options.equityQuotes?.stop()
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
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    if (!this.root.isDestroyed) this.root.destroyRecursively()
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
      if (this.notifyIfSessionExpired(error)) return
      this.chartHeader.content = `Chart  ·  Failed to load instruments: ${errorMessage(error)}`
      this.chartHeader.fg = "#ff6b6b"
    }
  }

  // Applies a live price tick in place. The stream carries only the traded
  // price, so the daily change is re-derived against the session's reference
  // close seeded from the opening screener snapshot.
  private onQuote(update: QuoteUpdate): void {
    if (this.destroyed) return
    this.accountPanel.applyQuote(update)
    const index = this.symbolIndex.get(update.symbol)
    if (index === undefined) return
    const instrument = this.instruments[index]
    if (!instrument) return

    if (update.lastPrice !== null) instrument.lastPrice = update.lastPrice
    if (update.lastPrice !== null) this.contractDetailsPanel.applyPrice(update.symbol, update.lastPrice)
    if (this.orderTicket && this.instruments[this.instrumentList.selectedIndex]?.symbol === update.symbol) {
      this.orderTicket.applyQuote({ lastPrice: update.lastPrice, ask: update.ask, bid: update.bid })
    }
    const reference = this.referenceClose.get(update.symbol)
    if (reference && reference > 0 && instrument.lastPrice !== null) {
      instrument.changePercent = (instrument.lastPrice / reference - 1) * 100
    }
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

  private async refreshInstrumentVolumes(): Promise<void> {
    if (this.destroyed || this.instruments.length === 0 || this.instrumentRefreshRequest) return
    const request = new AbortController()
    this.instrumentRefreshRequest = request
    try {
      const refreshed = await this.options.instruments.listInstruments({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.instrumentRefreshRequest !== request) return
      const volumes = new Map(refreshed.map((instrument) => [instrument.symbol, instrument.volume]))
      let changed = false
      for (const instrument of this.instruments) {
        if (!volumes.has(instrument.symbol)) continue
        const volume = volumes.get(instrument.symbol) ?? null
        if (instrument.volume === volume) continue
        instrument.volume = volume
        changed = true
      }
      if (changed && this.instrumentSort === "volume") {
        const selectedUid = this.instruments[this.instrumentList.selectedIndex]?.uid
        this.sortAndRenderInstrumentList(selectedUid, true)
      }
    } catch (error) {
      if (!this.destroyed && !request.signal.aborted && !isAbortError(error)) this.notifyIfSessionExpired(error)
    } finally {
      if (this.instrumentRefreshRequest === request) this.instrumentRefreshRequest = null
    }
  }

  private onEquityQuote(update: EquityQuoteUpdate): void {
    if (this.destroyed || update.symbol !== this.selectedEquitySymbol) return
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!instrument) return
    this.chart.updateLastPrice(instrument.uid, update.lastPrice, update.timestamp)
  }

  private async refreshNews(): Promise<void> {
    if (this.destroyed || this.articleOpen) return
    const instrument = this.instruments[this.instrumentList.selectedIndex]
    if (!instrument) return
    const uid = instrument.uid
    try {
      const articles = await this.options.news.listNews({ instrumentUid: uid })
      if (this.destroyed || this.articleOpen) return
      if (this.instruments[this.instrumentList.selectedIndex]?.uid !== uid) return
      if (newsListChanged(this.newsArticles, articles)) this.renderNews(articles, instrument.displayName)
    } catch (error) {
      if (!this.destroyed) this.notifyIfSessionExpired(error)
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
    if (this.selectedEquitySymbol) this.options.equityQuotes?.start(this.selectedEquitySymbol)
    else this.options.equityQuotes?.stop()
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

  private async loadContractDetails(instrument: ViopInstrument): Promise<void> {
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
      if (this.notifyIfSessionExpired(error)) return
      this.contractDetailsPanel.showError(instrument.uid)
    }
  }

  private async loadNews(instrument: ViopInstrument): Promise<void> {
    this.newsRequestUid = instrument.uid
    this.articleOpen = false
    this.setMessage("Loading news…", "#777777")
    try {
      const articles = await this.options.news.listNews({ instrumentUid: instrument.uid })
      if (this.destroyed || this.newsRequestUid !== instrument.uid) return
      this.renderNews(articles, instrument.displayName)
    } catch (error) {
      if (this.destroyed || this.newsRequestUid !== instrument.uid) return
      if (this.notifyIfSessionExpired(error)) return
      this.setMessage(`Failed to load news: ${errorMessage(error)}`, "#ff6b6b")
    }
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
      onError: (error) => this.notifyIfSessionExpired(error),
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
    this.hint.fg = "#777777"
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
    this.hint.content = t`${fg("#7c83ff")(`/${query}`)}  ${fg(match ? "#dddddd" : "#888888")(result)}  ${fg("#666666")("Enter select · Esc cancel")}`
    this.hint.fg = "#dddddd"
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
      if (this.notifyIfSessionExpired(error)) return
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
      if (this.notifyIfSessionExpired(error)) return
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
      this.hint.fg = "#777777"
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
      if (this.notifyIfSessionExpired(error)) return
      this.renderReaderMessage(`Failed to load article: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private notifyIfSessionExpired(error: unknown): boolean {
    if (!(error instanceof CredentialsRequiredError)) return false
    if (!this.sessionExpiredNotified) {
      this.sessionExpiredNotified = true
      this.options.onSessionExpired?.()
    }
    return true
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
    const order: Focus[] = ["instruments", "chart", "account", "news"]
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
  }

  private updateFocusIndicator(): void {
    this.renderViopHeader()
    this.paintSortToolbar()
    this.renderChartHeader()
    this.chart.setFocused(this.focus === "chart")
    this.accountPanel.setFocused(this.focus === "account")
    this.newsHeader.fg = this.focus === "news" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    this.updateResponsiveLayout()
  }

  private setEquityConnected(connected: boolean): void {
    if (this.equityConnected === connected) return
    this.equityConnected = connected
    this.renderChartHeader()
  }

  private renderChartHeader(): void {
    const titleColor = this.focus === "chart" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    if (!this.selectedEquitySymbol) {
      this.chartHeader.content = t`${fg(titleColor)("Chart")}`
      return
    }
    const statusColor = this.equityConnected ? UP_COLOR : NEUTRAL_COLOR
    const status = this.equityConnected ? "● live" : "○ snapshot"
    this.chartHeader.content = t`${fg(titleColor)("Chart")}  ${fg(HEADER_COLOR)(`${this.selectedEquitySymbol} stock`)}  ${fg(statusColor)(status)}`
  }

  private updateResponsiveLayout(): void {
    const compact = this.root.width < COMPACT_LAYOUT_WIDTH
    this.leftPanel.width = compact ? 30 : 36
    this.centerPanel.visible = !compact || this.focus !== "news"
    this.rightPanel.visible = !compact || this.focus === "news"
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

function isCapitalShortcut(key: KeyEvent, letter: "c" | "v"): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.sequence === letter.toUpperCase() || (key.shift && key.name === letter)
}

function isLowercaseShortcut(key: KeyEvent, letter: "c" | "x"): boolean {
  if (key.ctrl || key.shift || key.meta || key.option) return false
  return key.name === letter && key.sequence !== letter.toUpperCase()
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
