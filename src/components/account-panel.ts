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
  PortfolioSummary,
} from "../trading/account.ts"
import type { QuoteUpdate } from "../market/quote-stream.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const PANEL_BG = "#161616"
const ACTIVE_BUTTON_BG = "#333333"
const FOCUSED_COLOR = "#ffffff"
const UNFOCUSED_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const DEFAULT_REFRESH_INTERVAL_MS = 15_000

const TABS = ["portfolio", "orders", "positions"] as const
type AccountTab = (typeof TABS)[number]

const TAB_LABELS: Record<AccountTab, string> = {
  portfolio: "Portfolio",
  orders: "Orders",
  positions: "Positions",
}

export interface AccountPanelOptions {
  source?: AccountSource
  stream?: AccountStream
  onError?: (error: unknown) => void
  onFocusRequest?: () => void
  onPositionSelect?: (position: AccountPosition) => void
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
  private tab: AccountTab = "portfolio"
  private request: AbortController | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private focused = false
  private destroyed = false
  private liveSequence = 0
  private readonly liveUpdates: Array<{ sequence: number; update: AccountLiveUpdate }> = []
  // Position rows are reused across renders; see renderPositionRows.
  private positionRows: Array<{ row: BoxRenderable; text: TextRenderable; position: AccountPosition }> = []
  // Quote and account events arrive in bursts; they mutate the snapshot and
  // the visible tab is re-rendered once per burst.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.destroyed) this.renderContent()
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
      this.selectTab(TABS[(index + direction + TABS.length) % TABS.length] ?? "portfolio")
      return true
    }
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
      const snapshot = await source.loadAccount({ signal: request.signal })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.snapshot = snapshot
      const minimumSequence = hadSnapshot ? refreshStartedAtSequence : 0
      for (const item of this.liveUpdates) {
        if (item.sequence > minimumSequence) this.mergeLiveUpdate(item.update)
      }
      this.liveUpdates.length = 0
      this.syncPendingOrders()
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

  private selectTab(tab: AccountTab): void {
    if (this.tab === tab) return
    this.tab = tab
    this.paintTabs()
    this.body.scrollTo({ x: 0, y: 0 })
    this.renderContent()
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
    if (!this.snapshot) return
    if (this.tab === "positions" && this.snapshot.positions.length > 0) {
      this.renderPositionRows(this.snapshot.positions)
      return
    }
    const content = this.tab === "portfolio"
      ? renderPortfolio(this.snapshot.portfolio)
      : this.tab === "orders"
        ? renderOrders(this.snapshot.orders)
        : renderPositions(this.snapshot.positions)
    this.showTextContent(content, "#cccccc")
  }

  // Rows are reused between renders: live streams re-render this list on every
  // burst flush, and destroying and rebuilding a renderable per position at
  // that rate churns layout nodes. Each entry's `position` is kept current so
  // the row's click handler always selects what the row displays.
  private renderPositionRows(positions: AccountPosition[]): void {
    if (this.positionRows.length === 0) this.clearBody()
    while (this.positionRows.length > positions.length) {
      const extra = this.positionRows.pop()
      if (!extra) break
      this.body.remove(extra.row)
      if (!extra.row.isDestroyed) extra.row.destroyRecursively()
    }
    positions.forEach((position, index) => {
      const existing = this.positionRows[index]
      if (existing) {
        existing.position = position
        existing.text.content = new StyledText(positionChunks(position))
        return
      }
      const entry = {
        position,
        row: new BoxRenderable(this.renderer, {
          width: "100%",
          height: 1,
          flexShrink: 0,
          onMouseDown: (event) => {
            if (event.button !== 0) return
            this.options.onFocusRequest?.()
            this.options.onPositionSelect?.(entry.position)
          },
        }),
        text: new TextRenderable(this.renderer, {
          content: new StyledText(positionChunks(position)),
          width: "100%",
          wrapMode: "none",
        }),
      }
      entry.row.add(entry.text)
      this.body.add(entry.row)
      this.positionRows.push(entry)
    })
  }

  private showTextContent(content: StyledText | string, color: string): void {
    this.clearBody()
    this.content.content = content
    this.content.fg = color
    this.body.add(this.content)
  }

  private clearBody(): void {
    this.positionRows = []
    for (const child of this.body.getChildren()) {
      this.body.remove(child)
      if (child !== this.content && !child.isDestroyed) child.destroyRecursively()
    }
  }
}

export function renderPortfolio(portfolio: PortfolioSummary): StyledText {
  const dayProfitColor = (portfolio.dailyProfitLoss ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
  const periodProfitColor = (portfolio.periodProfitLoss ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
  return new StyledText([
    ...metricLine("Collateral", formatMoney(portfolio.totalCollateral, portfolio.currency)),
    fg("#cccccc")("\n"),
    ...metricLine("Available", formatMoney(portfolio.availableCollateral, portfolio.currency)),
    fg("#cccccc")("\n"),
    fg(MUTED_COLOR)("Day P/L".padEnd(12)),
    fg(dayProfitColor)(formatProfit(portfolio.dailyProfitLoss, portfolio.dailyProfitLossPercent, portfolio.currency)),
    fg("#cccccc")("\n"),
    fg(MUTED_COLOR)("Week P/L".padEnd(12)),
    fg(periodProfitColor)(formatProfit(portfolio.periodProfitLoss, portfolio.periodProfitLossPercent, portfolio.currency)),
  ])
}

export function renderOrders(orders: AccountOrder[]): StyledText | string {
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

export function renderPositions(positions: AccountPosition[]): StyledText | string {
  if (positions.length === 0) return "No open VIOP positions."
  const chunks: TextChunk[] = []
  positions.forEach((position, index) => {
    chunks.push(...positionChunks(position))
    if (index < positions.length - 1) chunks.push(fg("#cccccc")("\n"))
  })
  return new StyledText(chunks)
}

function positionChunks(position: AccountPosition): TextChunk[] {
  const pnlColor = (position.unrealizedProfitLoss ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
  return [
    fg("#dddddd")(`${position.displayName}  `),
    fg(MUTED_COLOR)(`${formatQuantity(position.quantity)}x  `),
    fg("#bbbbbb")(`${formatNumber(position.averageCost)}→${formatNumber(position.currentPrice)}  `),
    fg(pnlColor)(formatSignedMoney(position.unrealizedProfitLoss, position.currency)),
  ]
}

function metricLine(label: string, value: string): TextChunk[] {
  return [fg(MUTED_COLOR)(label.padEnd(12)), fg("#dddddd")(value)]
}

function formatProfit(value: number | null, percent: number | null, currency: string): string {
  const percentText = percent === null ? "" : `  ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`
  return `${formatSignedMoney(value, currency)}${percentText}`
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
