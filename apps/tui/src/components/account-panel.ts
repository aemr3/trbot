import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type {
  AccountOrder,
  AccountLiveUpdate,
  AccountPosition,
  AccountSnapshot,
  AccountSource,
  AccountStream,
  PortfolioPerformance,
  PortfolioRange,
  PortfolioSummary,
} from "@trbot/trading/account.ts"
import type { PriceAlertView } from "@trbot/market/alert-monitor.ts"
import { isTrailingAlert, type PriceAlertStatus } from "@trbot/market/alert.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { StopRuleView } from "@trbot/trading/stop-monitor.ts"
import { isTrailingStopRule, type StopRuleStatus } from "@trbot/trading/stop.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const PANEL_BG = "#161616"
const ACTIVE_BUTTON_BG = "#333333"
const FOCUSED_COLOR = "#ffffff"
const UNFOCUSED_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const DEFAULT_REFRESH_INTERVAL_MS = 15_000

// The portfolio summary is not a tab: it has a panel of its own under the
// instrument list. What is open leads, because it is what the other three tabs
// are all about.
const TABS = ["positions", "orders", "stops", "alerts"] as const
export type AccountTab = (typeof TABS)[number]

const TAB_LABELS = {
  positions: "Positions",
  orders: "Orders",
  stops: "Stops",
  alerts: "Alerts",
} satisfies Record<AccountTab, string>

const STATUS_LABELS = {
  ARMED: "armed",
  PAUSED: "paused",
  TRIGGERED: "triggered",
  DONE: "done",
} satisfies Record<StopRuleStatus, string>

const ALERT_STATUS_LABELS = {
  ARMED: "armed",
  PAUSED: "paused",
  TRIGGERED: "fired",
} satisfies Record<PriceAlertStatus, string>

export interface AccountPanelOptions {
  source?: AccountSource
  stream?: AccountStream
  onError?: (cause: unknown) => void
  onFocusRequest?: () => void
  onPositionSelect?: (position: AccountPosition) => void
  // The stops and alerts tabs report; the screen owns every action they name.
  onStopCreate?: () => void
  onStopEdit?: (view: StopRuleView) => void
  onStopToggle?: (view: StopRuleView) => void
  onAlertCreate?: () => void
  onAlertEdit?: (view: PriceAlertView) => void
  onAlertToggle?: (view: PriceAlertView) => void
  // Positions drive the stop monitor, so it hears about every change here.
  onPositionsChange?: (positions: AccountPosition[]) => void
  // The portfolio and its performance are shown by the portfolio panel, not by
  // this one; the range comes back the other way because the provider returns
  // both from the single call this panel already makes.
  onPortfolioChange?: (portfolio: PortfolioSummary) => void
  onPerformanceChange?: (performance: PortfolioPerformance) => void
  portfolioRange?: () => PortfolioRange
  refreshIntervalMs?: number
}

export class AccountPanel {
  readonly root: BoxRenderable

  private readonly body: ScrollBoxRenderable
  private readonly content: TextRenderable
  private readonly liveStatus: TextRenderable
  private readonly tabButtons = new Map<AccountTab, BoxRenderable>()
  private readonly tabLabels = new Map<AccountTab, TextRenderable>()
  private snapshot: AccountSnapshot | null = null
  private stopViews: StopRuleView[] = []
  private stopSelection = 0
  private alertViews: PriceAlertView[] = []
  private alertSelection = 0
  private tab: AccountTab = "positions"
  private request: AbortController | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private focused = false
  private destroyed = false
  private liveSequence = 0
  private readonly liveUpdates: Array<{ sequence: number; update: AccountLiveUpdate }> = []
  // Rows are reused across renders; see renderRows. `rowsKind` names the list
  // they were built for, so switching tabs rebuilds rather than repainting one
  // list's rows with another's contents.
  private rows: PanelRow[] = []
  private rowsKind: string | null = null
  // Quote and account events arrive in bursts; they mutate the snapshot and
  // the visible tab is re-rendered once per burst.
  private readonly liveRender = new RenderCoalescer(() => {
    // A coalesced repaint can land after the renderer tore the tree down.
    if (!this.destroyed && !this.root.isDestroyed) this.renderContent()
  })

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AccountPanelOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      height: 8,
      flexShrink: 0,
      flexDirection: "column",
      border: ["top"],
      borderColor: "#303030",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
    })

    const tabs = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      gap: 2,
      marginBottom: 1,
    })
    for (const tab of TABS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectTab(tab)
        },
      })
      const label = new TextRenderable(renderer, { content: TAB_LABELS[tab], wrapMode: "none" })
      button.add(label)
      tabs.add(button)
      this.tabButtons.set(tab, button)
      this.tabLabels.set(tab, label)
    }
    tabs.add(new BoxRenderable(renderer, { flexGrow: 1 }))
    this.liveStatus = new TextRenderable(renderer, {
      content: options.stream ? "○ sync" : "",
      fg: MUTED_COLOR,
      wrapMode: "none",
    })
    tabs.add(this.liveStatus)

    this.body = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: PANEL_BG,
      contentOptions: { flexDirection: "column", paddingRight: 2, backgroundColor: PANEL_BG },
      onMouseDown: (event) => {
        if (event.button === 0) this.options.onFocusRequest?.()
      },
    })
    this.content = new TextRenderable(renderer, {
      content: options.source ? "Loading account…" : "Account data is unavailable.",
      fg: MUTED_COLOR,
      width: "100%",
      wrapMode: "none",
    })
    this.body.add(this.content)
    this.root.add(tabs)
    this.root.add(this.body)
    this.paintTabs()
  }

  mount(): void {
    if (!this.options.source || this.destroyed) return
    this.options.stream?.subscribe((update) => this.applyLiveUpdate(update))
    this.options.stream?.onConnectionChange((connected) => this.setConnected(connected))
    this.options.stream?.start()
    void this.refresh()
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    )
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.liveRender.cancel()
    this.options.stream?.stop()
    this.request?.abort()
    this.request = null
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.paintTabs()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l") {
      const direction = key.name === "left" || key.name === "h" ? -1 : 1
      const index = TABS.indexOf(this.tab)
      this.selectTab(TABS[(index + direction + TABS.length) % TABS.length] ?? "positions")
      return true
    }
    // On the stops and alerts tabs the row keys move a selection instead of
    // scrolling, and the rule actions take over the letters.
    if (this.tab === "stops" && this.handleStopKey(key)) return true
    if (this.tab === "alerts" && this.handleAlertKey(key)) return true
    if (!key.ctrl && key.name === "r") {
      void this.refresh()
      return true
    }
    if (key.name === "up" || key.name === "k") {
      this.body.scrollBy({ x: 0, y: -1 })
      return true
    }
    if (key.name === "down" || key.name === "j") {
      this.body.scrollBy({ x: 0, y: 1 })
      return true
    }
    if (key.name === "home") {
      this.body.scrollTo({ x: 0, y: 0 })
      return true
    }
    return false
  }

  private handleStopKey(key: KeyEvent): boolean {
    if (key.ctrl || key.meta || key.option) return false
    const selected = this.stopViews[this.stopSelection]
    if (key.name === "n") {
      this.options.onStopCreate?.()
      return true
    }
    if (key.name === "up" || key.name === "k" || key.name === "down" || key.name === "j") {
      if (this.stopViews.length === 0) return false
      const direction = key.name === "up" || key.name === "k" ? -1 : 1
      this.stopSelection = Math.max(0, Math.min(this.stopSelection + direction, this.stopViews.length - 1))
      this.renderContent()
      return true
    }
    if (!selected) return false
    if (key.name === "e" || key.name === "return") {
      this.options.onStopEdit?.(selected)
      return true
    }
    if (key.name === "space") {
      this.options.onStopToggle?.(selected)
      return true
    }
    // Deleting is destructive, so the screen owns it and its confirmation.
    return false
  }

  private handleAlertKey(key: KeyEvent): boolean {
    if (key.ctrl || key.meta || key.option) return false
    const selected = this.alertViews[this.alertSelection]
    if (key.name === "n") {
      this.options.onAlertCreate?.()
      return true
    }
    if (key.name === "up" || key.name === "k" || key.name === "down" || key.name === "j") {
      if (this.alertViews.length === 0) return false
      const direction = key.name === "up" || key.name === "k" ? -1 : 1
      this.alertSelection = Math.max(0, Math.min(this.alertSelection + direction, this.alertViews.length - 1))
      this.renderContent()
      return true
    }
    if (!selected) return false
    if (key.name === "e" || key.name === "return") {
      this.options.onAlertEdit?.(selected)
      return true
    }
    if (key.name === "space") {
      this.options.onAlertToggle?.(selected)
      return true
    }
    // Deleting is destructive, so the screen owns it and its confirmation.
    return false
  }

  /** The rule the stops tab is pointing at, for actions the screen owns. */
  selectedStop(): StopRuleView | null {
    if (this.tab !== "stops") return null
    return this.stopViews[this.stopSelection] ?? null
  }

  /** The alert the alerts tab is pointing at, for actions the screen owns. */
  selectedAlert(): PriceAlertView | null {
    if (this.tab !== "alerts") return null
    return this.alertViews[this.alertSelection] ?? null
  }

  /** Replaces the stops tab's contents; the monitor owns what they say. */
  showStopRules(views: StopRuleView[]): void {
    if (this.destroyed) return
    this.stopViews = views
    this.stopSelection = Math.max(0, Math.min(this.stopSelection, views.length - 1))
    // Position rows carry their own rules, so they repaint on this too — a
    // trail that advanced or a feed that died shows without changing tabs.
    if (this.tab === "stops" || this.tab === "positions") this.liveRender.schedule()
  }

  /** Replaces the alerts tab's contents; the monitor owns what they say. */
  showPriceAlerts(views: PriceAlertView[]): void {
    if (this.destroyed) return
    this.alertViews = views
    this.alertSelection = Math.max(0, Math.min(this.alertSelection, views.length - 1))
    if (this.tab === "alerts") this.liveRender.schedule()
  }

  selectTab(tab: AccountTab): void {
    if (this.tab === tab) return
    this.tab = tab
    this.paintTabs()
    this.body.scrollTo({ x: 0, y: 0 })
    this.renderContent()
  }

  applyQuote(update: QuoteUpdate): void {
    if (!this.snapshot || update.lastPrice === null || this.destroyed) return
    const position = this.snapshot.positions.find((candidate) => candidate.symbol === update.symbol)
    if (!position) return
    position.currentPrice = update.lastPrice
    position.unrealizedProfitLoss = positionProfitLoss(position)
    if (this.tab === "positions") this.liveRender.schedule()
  }

  async refresh(): Promise<void> {
    const source = this.options.source
    if (!source || this.destroyed) return
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    const refreshStartedAtSequence = this.liveSequence
    const hadSnapshot = this.snapshot !== null
    if (!this.snapshot) {
      this.content.content = "Loading account…"
      this.content.fg = MUTED_COLOR
    }
    try {
      const snapshot = await source.loadAccount({
        signal: request.signal,
        portfolioRange: this.options.portfolioRange?.(),
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.snapshot = snapshot
      const minimumSequence = hadSnapshot ? refreshStartedAtSequence : 0
      for (const item of this.liveUpdates) {
        if (item.sequence > minimumSequence) this.mergeLiveUpdate(item.update)
      }
      this.liveUpdates.length = 0
      this.syncPendingOrders()
      this.options.onPositionsChange?.(snapshot.positions)
      this.options.onPortfolioChange?.(snapshot.portfolio)
      this.options.onPerformanceChange?.(snapshot.performance)
      this.renderContent()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) return
      this.showTextContent(`Failed to load account: ${errorMessage(error)}`, DOWN_COLOR)
      this.options.onError?.(error)
    }
  }

  private applyLiveUpdate(update: AccountLiveUpdate): void {
    if (this.destroyed) return
    const sequence = ++this.liveSequence
    this.liveUpdates.push({ sequence, update })
    if (this.liveUpdates.length > 100) this.liveUpdates.shift()
    if (!this.snapshot) return
    this.mergeLiveUpdate(update)
    if (update.type === "order") this.syncPendingOrders()
    // A position that moved or closed changes what the stop rules protect.
    if (update.type === "position") this.options.onPositionsChange?.(this.snapshot.positions)
    // Collateral moves with every fill, and it is read outside this panel.
    if (update.type === "collateral") this.options.onPortfolioChange?.(this.snapshot.portfolio)
    this.liveRender.schedule()
  }

  private mergeLiveUpdate(update: AccountLiveUpdate): void {
    const snapshot = this.snapshot
    if (!snapshot) return
    snapshot.updatedAt = Date.now()
    if (update.type === "collateral") {
      snapshot.portfolio.availableCollateral = update.availableCollateral
      return
    }
    if (update.type === "order") {
      const order = snapshot.orders.find((candidate) => candidate.uid === update.uid)
      if (!order) return
      order.status = update.status
      order.value = update.description ?? update.providerStatus
      return
    }
    const index = snapshot.positions.findIndex((candidate) => candidate.uid === update.uid)
    if (index === -1) return
    if (update.quantity === 0) {
      snapshot.positions.splice(index, 1)
      return
    }
    const position = snapshot.positions[index]
    if (!position) return
    position.quantity = update.quantity
    if (update.averageCost !== null) position.averageCost = update.averageCost
    position.unrealizedProfitLoss = positionProfitLoss(position)
  }

  private syncPendingOrders(): void {
    this.options.stream?.setPendingOrders(
      this.snapshot?.orders.filter((order) => order.status === "pending").map((order) => order.uid) ?? [],
    )
  }

  private setConnected(connected: boolean): void {
    if (this.destroyed) return
    this.liveStatus.content = connected ? "● live" : "○ sync"
    this.liveStatus.fg = connected ? UP_COLOR : MUTED_COLOR
  }

  private paintTabs(): void {
    for (const tab of TABS) {
      const selected = tab === this.tab
      const button = this.tabButtons.get(tab)
      const label = this.tabLabels.get(tab)
      if (!button || !label) continue
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : PANEL_BG
      label.fg = selected ? FOCUSED_COLOR : this.focused ? MUTED_COLOR : UNFOCUSED_COLOR
    }
  }

  private renderContent(): void {
    if (this.tab === "stops") {
      if (this.stopViews.length === 0) {
        this.showTextContent(renderStops(this.stopViews), MUTED_COLOR)
        return
      }
      this.renderRows("stops", this.stopViews, stopChunks, this.stopSelection)
      return
    }
    if (this.tab === "alerts") {
      if (this.alertViews.length === 0) {
        this.showTextContent(renderPriceAlerts(this.alertViews), MUTED_COLOR)
        return
      }
      this.renderRows("alerts", this.alertViews, alertChunks, this.alertSelection)
      return
    }
    if (!this.snapshot) return
    if (this.tab === "positions" && this.snapshot.positions.length > 0) {
      this.renderRows("positions", this.snapshot.positions, (position) =>
        positionChunks(position, this.stopViews))
      return
    }
    const content = this.tab === "orders"
      ? renderOrders(this.snapshot.orders)
      : renderPositions(this.snapshot.positions, this.stopViews)
    this.showTextContent(content, "#cccccc")
  }

  /**
   * Paints one row per item, reusing the renderables between renders: live
   * streams re-render these lists on every burst flush, and rebuilding a
   * renderable per row at that rate churns layout nodes. Each entry's `select`
   * and `item` are refreshed in place, so a row's click always acts on what the
   * row currently displays.
   */
  private renderRows<T>(kind: string, items: T[], chunks: (item: T) => TextChunk[], selected?: number): void {
    if (this.rowsKind !== kind) {
      this.clearBody()
      this.rowsKind = kind
    }
    while (this.rows.length > items.length) {
      const extra = this.rows.pop()
      if (!extra) break
      this.body.remove(extra.row)
      if (!extra.row.isDestroyed) extra.row.destroyRecursively()
    }
    items.forEach((item, index) => {
      // A list without a selection leaves every row on the panel background.
      const background = selected === index ? ACTIVE_BUTTON_BG : PANEL_BG
      const existing = this.rows[index]
      if (existing) {
        existing.text.content = new StyledText(chunks(item))
        existing.row.backgroundColor = background
        return
      }
      const entry: PanelRow = {
        row: new BoxRenderable(this.renderer, {
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: background,
          onMouseDown: (event) => {
            if (event.button !== 0) return
            this.options.onFocusRequest?.()
            this.selectRow(entry)
          },
        }),
        text: new TextRenderable(this.renderer, {
          content: new StyledText(chunks(item)),
          width: "100%",
          wrapMode: "none",
        }),
      }
      entry.row.add(entry.text)
      this.body.add(entry.row)
      this.rows.push(entry)
    })
  }

  /** Moves the current tab's selection to a clicked row and acts on it. */
  private selectRow(entry: PanelRow): void {
    const index = this.rows.indexOf(entry)
    if (index < 0) return
    if (this.tab === "stops") {
      this.stopSelection = index
      this.renderContent()
      const view = this.stopViews[index]
      if (view) this.options.onStopEdit?.(view)
      return
    }
    if (this.tab === "alerts") {
      this.alertSelection = index
      this.renderContent()
      const view = this.alertViews[index]
      if (view) this.options.onAlertEdit?.(view)
      return
    }
    if (this.tab === "positions") {
      const position = this.snapshot?.positions[index]
      if (position) this.options.onPositionSelect?.(position)
    }
  }

  private showTextContent(content: StyledText | string, color: string): void {
    this.clearBody()
    this.content.content = content
    this.content.fg = color
    this.body.add(this.content)
  }

  private clearBody(): void {
    this.rows = []
    this.rowsKind = null
    for (const child of this.body.getChildren()) {
      this.body.remove(child)
      if (child !== this.content && !child.isDestroyed) child.destroyRecursively()
    }
  }
}

interface PanelRow {
  row: BoxRenderable
  text: TextRenderable
}

function renderOrders(orders: AccountOrder[]): StyledText | string {
  if (orders.length === 0) return "No VIOP orders."
  const chunks: TextChunk[] = []
  orders.forEach((order, index) => {
    const statusColor = order.status === "pending" ? "#e5c07b" : MUTED_COLOR
    const details = [order.description, order.value].filter(Boolean).join(" · ")
    chunks.push(fg(statusColor)(order.status === "pending" ? "PENDING  " : "DONE     "))
    chunks.push(fg("#dddddd")(order.title))
    if (details) chunks.push(fg(MUTED_COLOR)(`  ${details}`))
    if (index < orders.length - 1) chunks.push(fg("#cccccc")("\n"))
  })
  return new StyledText(chunks)
}

function renderPositions(
  positions: AccountPosition[],
  stops: StopRuleView[] = [],
): StyledText | string {
  if (positions.length === 0) return "No open VIOP positions."
  const chunks: TextChunk[] = []
  positions.forEach((position, index) => {
    chunks.push(...positionChunks(position, stops))
    if (index < positions.length - 1) chunks.push(fg("#cccccc")("\n"))
  })
  return new StyledText(chunks)
}

function renderStops(views: StopRuleView[]): StyledText | string {
  if (views.length === 0) return "No stop rules. Press n to add one."
  const chunks: TextChunk[] = []
  views.forEach((view, index) => {
    chunks.push(...stopChunks(view))
    if (index < views.length - 1) chunks.push(fg("#cccccc")("\n"))
  })
  return new StyledText(chunks)
}

// One rule per row: what it protects, where the level is, how far the market
// still has to travel, and whether it is actually watching.
function stopChunks(view: StopRuleView): TextChunk[] {
  const { rule } = view
  const marker = stopMarker(view)
  const state = rule.status === "ARMED" && view.feed !== "live"
    ? feedLabel(view.feed, rule.basis === "CLOSE")
    : !view.hasPosition && rule.status !== "DONE"
      ? "no position"
      : STATUS_LABELS[rule.status]
  const distance = view.distancePercent === null
    ? "    —"
    : `${view.distancePercent >= 0 ? "+" : ""}${view.distancePercent.toFixed(1)}%`.padStart(6)
  return [
    fg("#dddddd")(`${rule.displayName.slice(0, 8).padEnd(9)}`),
    fg(rule.role === "STOP" ? DOWN_COLOR : UP_COLOR)(rule.role === "STOP" ? "S" : "T"),
    fg("#bbbbbb")(formatNumber(view.level).padStart(9)),
    fg(MUTED_COLOR)(`${distance} ${stopKindLabel(view)} `),
    marker,
    fg(MUTED_COLOR)(` ${state}`),
  ]
}

/**
 * Whether a rule is actually watching, in one glyph: filled while the feed is
 * live, hollowed when it is not, and pointing up once the level was reached.
 */
function stopMarker(view: StopRuleView): TextChunk {
  if (view.rule.status === "TRIGGERED") return fg(DOWN_COLOR)("▲")
  if (view.rule.status !== "ARMED") return fg(MUTED_COLOR)("○")
  return view.feed === "live" ? fg(UP_COLOR)("●") : fg("#e5c07b")("◐")
}

/** Short label for how the level is derived, plus its trigger basis. */
function stopKindLabel(view: StopRuleView): string {
  const { rule } = view
  const kind = rule.kind === "PRICE"
    ? "price"
    : rule.kind === "PERCENT"
      ? `${formatQuantity(rule.value)}%`
      : rule.kind === "ATR"
        ? `${formatQuantity(rule.value)}atr`
        : isTrailingStopRule(rule.kind)
          ? `trail${rule.kind === "TRAILING_ATR" ? "atr" : "%"}`
          : rule.kind
  return `${kind}${rule.basis === "CLOSE" ? "@cl" : ""}`.padEnd(9)
}

/**
 * Why a rule is not watching, named after the feed it actually reads. A
 * close-based rule never touches the tick stream, so reporting "no feed" for
 * one sends the trader looking at the wrong thing entirely.
 */
function feedLabel(feed: StopRuleView["feed"], fromCandles: boolean): string {
  if (feed === "stale") return fromCandles ? "old candle" : "stale"
  return fromCandles ? "no candles" : "no feed"
}

function renderPriceAlerts(views: PriceAlertView[]): StyledText | string {
  if (views.length === 0) return "No price alerts. Press n to add one."
  const chunks: TextChunk[] = []
  views.forEach((view, index) => {
    chunks.push(...alertChunks(view))
    if (index < views.length - 1) chunks.push(fg("#cccccc")("\n"))
  })
  return new StyledText(chunks)
}

// One alert per row, laid out on the same columns as a stop: what it watches,
// where the level is, how far the market still has to travel, and whether it is
// actually watching.
function alertChunks(view: PriceAlertView): TextChunk[] {
  const { alert } = view
  const marker = alert.status === "ARMED"
    ? (view.feed === "live" ? fg(UP_COLOR)("●") : fg("#e5c07b")("◐"))
    : alert.status === "TRIGGERED"
      ? fg("#e5c07b")("★")
      : fg(MUTED_COLOR)("○")
  const state = alert.status === "ARMED" && view.feed !== "live"
    ? feedLabel(view.feed, alert.basis === "CLOSE")
    : ALERT_STATUS_LABELS[alert.status]
  // A repeating alert never reads as spent, so the row says so outright rather
  // than leaving the trader to open the editor to find out.
  const repeat = alert.repeat === "ALWAYS" ? " ↻" : ""
  const distance = view.distancePercent === null
    ? "    —"
    : `${view.distancePercent >= 0 ? "+" : ""}${view.distancePercent.toFixed(1)}%`.padStart(6)
  return [
    fg("#dddddd")(`${alert.displayName.slice(0, 8).padEnd(9)}`),
    fg(alert.direction === "ABOVE" ? UP_COLOR : DOWN_COLOR)(alert.direction === "ABOVE" ? "↑" : "↓"),
    fg("#bbbbbb")(formatNumber(view.level).padStart(9)),
    fg(MUTED_COLOR)(`${distance} ${alertKindLabel(view)} `),
    marker,
    fg(MUTED_COLOR)(` ${state}${repeat}`),
  ]
}

function alertKindLabel(view: PriceAlertView): string {
  const { alert } = view
  const kind = alert.kind === "PRICE"
    ? "price"
    : alert.kind === "PERCENT"
      ? `${formatQuantity(alert.value)}%`
      : alert.kind === "ATR"
        ? `${formatQuantity(alert.value)}atr`
        : isTrailingAlert(alert.kind)
          ? `trail${alert.kind === "TRAILING_ATR" ? "atr" : "%"}`
          : alert.kind
  return `${kind}${alert.basis === "CLOSE" ? "@cl" : ""}`.padEnd(9)
}

function positionChunks(position: AccountPosition, stops: StopRuleView[] = []): TextChunk[] {
  const pnlColor = (position.unrealizedProfitLoss ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
  const chunks = [
    fg("#dddddd")(`${position.displayName}  `),
    fg(MUTED_COLOR)(`${formatQuantity(position.quantity)}x  `),
    fg("#bbbbbb")(`${formatNumber(position.averageCost)}→${formatNumber(position.currentPrice)}  `),
    fg(pnlColor)(formatSignedMoney(position.unrealizedProfitLoss, position.currency)),
  ]
  // The protective levels this position is carrying, so the stops tab is where
  // rules are managed rather than where they have to be checked. The row is
  // clipped rather than wrapped, so these trail off the end when space runs out.
  for (const view of positionStops(position, stops)) {
    const isStop = view.rule.role === "STOP"
    chunks.push(
      fg(isStop ? DOWN_COLOR : UP_COLOR)(`   ${isStop ? "S" : "T"} `),
      fg("#bbbbbb")(`${formatNumber(view.level)} `),
      stopMarker(view),
    )
  }
  return chunks
}

/**
 * The rules a position is currently protected by, loss side first. Paused and
 * finished rules are left to the stops tab: a position row should say what is
 * watching it now, not what once did.
 */
function positionStops(position: AccountPosition, stops: StopRuleView[]): StopRuleView[] {
  return stops
    .filter(
      (view) =>
        (view.rule.status === "ARMED" || view.rule.status === "TRIGGERED") &&
        (view.rule.instrumentUid === position.uid || view.rule.symbol === position.symbol),
    )
    .sort((left, right) => (left.rule.role === right.rule.role ? 0 : left.rule.role === "STOP" ? -1 : 1))
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null) return "—"
  const amount = value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "TRY" ? `₺${amount}` : `${amount} ${currency}`
}

function formatSignedMoney(value: number | null, currency: string): string {
  if (value === null) return "—"
  const absolute = formatMoney(Math.abs(value), currency)
  return `${value >= 0 ? "+" : "-"}${absolute}`
}

function formatNumber(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatQuantity(value: number): string {
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })
}

function positionProfitLoss(position: AccountPosition): number | null {
  if (position.averageCost === null || position.currentPrice === null) return null
  return (position.currentPrice - position.averageCost) * position.quantity * (position.multiplier ?? 1)
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
