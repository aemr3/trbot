import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import {
  describeRange,
  type BrokerageDatePreset,
  type BrokerageDateRange,
} from "@trbot/market/broker-calendar.ts"
import type { BrokerageDistribution, BrokerageSide } from "@trbot/market/brokerage.ts"
import type { SettlementAnalysis, SettlementMode } from "@trbot/market/settlement.ts"
import { shortBroker } from "./depth-panel.ts"
import {
  barWidth,
  padSegments,
  plain,
  segment,
  shade,
  truncate,
  type Segment,
} from "./shaded-row.ts"

const PANEL_BG = "#161616"
const HEADING_COLOR = "#eeeeee"
const MUTED_COLOR = "#888888"
const FAINT_COLOR = "#666666"
const VALUE_COLOR = "#dddddd"
const BUY_COLOR = "#70d7a1"
const SELL_COLOR = "#ff6b6b"
const HOLD_COLOR = "#8f95ff"
const BUY_BAR_BG = "#16311f"
const SELL_BAR_BG = "#3a1f1f"
const HOLD_BAR_BG = "#232445"
const OTHER_COLOR = "#777777"
const SELECTED_TAB_BG = "#282828"
const WARNING_COLOR = "#e5c07b"

const PANEL_PADDING = 1
const MIN_BROKER_WIDTH = 8
// Top border, the two toolbar rows, blank, the three summary lines, blank,
// column header.
const FIXED_ROWS = 1 + 2 + 1 + 3 + 1 + 1

// The trade flow either side of the range, then the settlement register behind
// it: what each house was left holding, and who added to or shed a position.
const VIEWS = ["BUYER", "SELLER", "HELD", "GAINED", "LOST"] as const
export type BrokerView = (typeof VIEWS)[number]

const VIEW_LABELS: Record<BrokerView, string> = {
  BUYER: "Buyers",
  SELLER: "Sellers",
  HELD: "Held",
  GAINED: "Gained",
  LOST: "Lost",
}

const VIEW_COLORS: Record<BrokerView, string> = {
  BUYER: BUY_COLOR,
  SELLER: SELL_COLOR,
  HELD: HOLD_COLOR,
  GAINED: BUY_COLOR,
  LOST: SELL_COLOR,
}

const VIEW_BAR_BACKGROUNDS: Record<BrokerView, string> = {
  BUYER: BUY_BAR_BG,
  SELLER: SELL_BAR_BG,
  HELD: HOLD_BAR_BG,
  GAINED: BUY_BAR_BG,
  LOST: SELL_BAR_BG,
}

// Which feed backs a view. Exactly one of the two answers a view, so a caller
// can route a load by asking both.
export function brokerageSideOf(view: BrokerView): BrokerageSide | null {
  return view === "BUYER" || view === "SELLER" ? view : null
}

export function settlementModeOf(view: BrokerView): SettlementMode | null {
  return view === "HELD" || view === "GAINED" || view === "LOST" ? view : null
}

export interface BrokeragePanelOptions {
  onViewChange?: (view: BrokerView) => void
  onOpenDateRange?: () => void
  onFocusRequest?: () => void
}

// A ranked house as the table draws it: the name, the figures beside it, and
// the share that scales the bar behind it. Both feeds are reduced to this so
// the summary, the layout and the scrolling stay single-path.
interface TableRow {
  brokerage: string
  percentage: number
  values: string[]
}

interface TableColumn {
  title: string
  width: number
}

interface TableModel {
  color: string
  barBackground: string
  // How many leading houses the provider groups into its headline share.
  topCount: number
  topPercentage: number
  topLots: number
  otherLots: number
  columns: TableColumn[]
  rows: TableRow[]
}

// Shows which brokerage houses moved the underlying stock over a date range and
// what they were left holding afterwards: the leading houses' combined share,
// then every house ranked beneath it.
export class BrokeragePanel {
  readonly root: BoxRenderable

  private readonly title: TextRenderable
  private readonly viewButtons = new Map<BrokerView, BoxRenderable>()
  private readonly viewButtonLabels = new Map<BrokerView, TextRenderable>()
  private readonly rangeLabel: TextRenderable
  private readonly content: TextRenderable
  private view: BrokerView = "BUYER"
  private table: TableModel | null = null
  private range: BrokerageDateRange = { start: null, end: null }
  // Kept across contract switches: the calendar names the range, not the stock.
  private presets: BrokerageDatePreset[] = []
  private message: { text: string; color: string } | null = null
  private emptyMessage: string | null = null
  private distributionEntitled: boolean | null = null
  private settlementEntitled: boolean | null = null
  private focused = false
  private scrollOffset = 0

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: BrokeragePanelOptions = {},
  ) {
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingLeft: PANEL_PADDING,
      paddingRight: PANEL_PADDING,
      backgroundColor: PANEL_BG,
      border: ["top"],
      borderColor: "#303030",
      onSizeChange: () => this.render(),
      onMouseDown: (event) => {
        if (event.button === 0) this.options.onFocusRequest?.()
      },
    })
    // Five tabs and the range label together outgrow the panel's width, so the
    // range keeps the header row and the tabs take one of their own.
    const header = new BoxRenderable(renderer, { flexDirection: "row", height: 1, flexShrink: 0 })
    this.title = new TextRenderable(renderer, { content: "Brokers", fg: FAINT_COLOR })
    header.add(this.title)
    header.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1 }))
    this.rangeLabel = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      onMouseDown: (event) => {
        if (event.button !== 0) return
        this.options.onFocusRequest?.()
        this.options.onOpenDateRange?.()
      },
    })
    header.add(this.rangeLabel)
    // The tabs are real boxes rather than styled text so they can be clicked as
    // well as cycled with the arrow keys.
    const tabs = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
      marginBottom: 1,
    })
    for (const view of VIEWS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectView(view)
        },
      })
      const label = new TextRenderable(renderer, { content: VIEW_LABELS[view] })
      button.add(label)
      tabs.add(button)
      this.viewButtons.set(view, button)
      this.viewButtonLabels.set(view, label)
    }
    this.content = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      width: "100%",
      flexGrow: 1,
      wrapMode: "none",
    })
    this.root.add(header)
    this.root.add(tabs)
    this.root.add(this.content)
    this.render()
  }

  get activeView(): BrokerView {
    return this.view
  }

  setDistributionEntitled(entitled: boolean | null): void {
    if (this.distributionEntitled === entitled) return
    this.distributionEntitled = entitled
    this.render()
  }

  setSettlementEntitled(entitled: boolean | null): void {
    if (this.settlementEntitled === entitled) return
    this.settlementEntitled = entitled
    this.render()
  }

  // Clears the table for a new contract while the first load is in flight.
  reset(): void {
    this.table = null
    this.scrollOffset = 0
    this.message = null
    this.emptyMessage = null
    this.render()
  }

  setRange(range: BrokerageDateRange): void {
    this.range = range
    this.render()
  }

  showDistribution(distribution: BrokerageDistribution): void {
    if (distribution.side !== this.view) return
    this.presets = distribution.presets
    this.emptyMessage = null
    this.showTable(distributionTable(distribution))
  }

  showSettlement(analysis: SettlementAnalysis): void {
    if (analysis.mode !== this.view) return
    this.presets = analysis.presets
    this.emptyMessage = analysis.unavailableMessage
    this.showTable(settlementTable(analysis))
  }

  showMessage(text: string, color = MUTED_COLOR): void {
    this.message = { text, color }
    this.render()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.render()
  }

  handleKey(key: KeyEvent): void {
    if (key.ctrl || key.meta || key.option) return
    if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") {
      const direction = key.name === "left" || key.name === "h" ? -1 : 1
      const next = (VIEWS.indexOf(this.view) + direction + VIEWS.length) % VIEWS.length
      this.selectView(VIEWS[next] ?? "BUYER")
      return
    }
    if (key.name === "d") {
      this.options.onOpenDateRange?.()
      return
    }
    if (key.name === "home") {
      this.scrollOffset = 0
      this.render()
      return
    }
    if (key.name === "up" || key.name === "k") this.scrollBy(-1)
    else if (key.name === "down" || key.name === "j") this.scrollBy(1)
  }

  private showTable(table: TableModel): void {
    this.table = table
    this.message = null
    this.clampScroll()
    this.render()
  }

  private selectView(view: BrokerView): void {
    if (this.view === view) return
    this.view = view
    this.table = null
    this.emptyMessage = null
    this.scrollOffset = 0
    this.render()
    this.options.onViewChange?.(view)
  }

  private scrollBy(delta: number): void {
    const previous = this.scrollOffset
    this.scrollOffset = Math.max(0, this.scrollOffset + delta)
    this.clampScroll()
    if (this.scrollOffset !== previous) {
      this.render()
      this.renderer.requestRender()
    }
  }

  private clampScroll(): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScroll()))
  }

  private maxScroll(): number {
    const table = this.table
    if (!table) return 0
    const layout = this.tableLayout(table)
    return Math.max(0, layout.tail.length - layout.visibleTail)
  }

  private render(): void {
    this.renderTabs()
    const message = this.messageState()
    if (message) {
      this.content.content = new StyledText([fg(message.color)(message.text)])
      return
    }
    const table = this.table
    if (!table) return

    const width = this.contentWidth()
    this.content.content = new StyledText([
      ...summaryChunks(table, width),
      newline(),
      newline(),
      ...this.tableChunks(table, width),
    ])
  }

  private renderTabs(): void {
    this.title.fg = this.focused ? "#ffffff" : FAINT_COLOR
    for (const view of VIEWS) {
      const active = this.view === view
      const button = this.viewButtons.get(view)
      const label = this.viewButtonLabels.get(view)
      if (!button || !label) continue
      button.backgroundColor = active ? SELECTED_TAB_BG : undefined
      label.fg = active ? VIEW_COLORS[view] : this.focused ? "#aaaaaa" : FAINT_COLOR
    }
    this.rangeLabel.content = describeRange(this.range, this.presets)
    this.rangeLabel.fg = this.focused ? HEADING_COLOR : MUTED_COLOR
  }

  private messageState(): { text: string; color: string } | null {
    const settlement = settlementModeOf(this.view) !== null
    const entitled = settlement ? this.settlementEntitled : this.distributionEntitled
    const subject = settlement ? "settlement analysis" : "broker distribution"
    if (entitled === null) return { text: `Checking ${subject} access…`, color: MUTED_COLOR }
    if (!entitled) {
      return {
        text: `${settlement ? "Settlement analysis" : "Broker distribution"} is a paid feature\nand is not enabled on this account.`,
        color: WARNING_COLOR,
      }
    }
    if (this.message) return this.message
    if (!this.table) return { text: `Loading ${subject}…`, color: MUTED_COLOR }
    if (this.table.rows.length === 0) {
      // The register is only published once a session has cleared, so an empty
      // range is usually the provider saying it has nothing for that day yet.
      if (this.emptyMessage) return { text: this.emptyMessage, color: WARNING_COLOR }
      return { text: `No ${settlement ? "settled holdings" : "broker activity"} in this range.`, color: MUTED_COLOR }
    }
    return null
  }

  private contentWidth(): number {
    return Math.max(0, this.root.width - PANEL_PADDING * 2)
  }

  // Splits the ranked houses into the leading group, which stays pinned, and the
  // scrollable tail beneath it.
  private tableLayout(table: TableModel) {
    const capacity = Math.max(0, this.root.height - FIXED_ROWS)
    const topCount = Math.min(table.topCount, table.rows.length)
    const top = table.rows.slice(0, Math.min(topCount, capacity))
    const tail = table.rows.slice(topCount)
    // The divider only earns its row when there is a tail to separate.
    const afterTop = Math.max(0, capacity - top.length - (tail.length > 0 ? 1 : 0))
    const needsIndicator = tail.length > afterTop
    const visibleTail = Math.max(0, needsIndicator ? afterTop - 1 : afterTop)
    return { top, tail, visibleTail, showDivider: tail.length > 0 && capacity > top.length }
  }

  private tableChunks(table: TableModel, width: number): TextChunk[] {
    const brokerWidth = brokerColumnWidth(table.columns, width)
    const maxPercentage = Math.max(1, ...table.rows.map((row) => row.percentage))
    const layout = this.tableLayout(table)
    const chunks: TextChunk[] = [...headerRow(table.columns, brokerWidth, width)]

    for (const row of layout.top) {
      chunks.push(newline(), ...valueRow(row, table, brokerWidth, width, maxPercentage))
    }
    if (layout.showDivider) chunks.push(newline(), fg(FAINT_COLOR)("─".repeat(width)))

    const visible = layout.tail.slice(this.scrollOffset, this.scrollOffset + layout.visibleTail)
    for (const row of visible) {
      chunks.push(newline(), ...valueRow(row, table, brokerWidth, width, maxPercentage))
    }

    const remaining = layout.tail.length - this.scrollOffset - visible.length
    if (remaining > 0) {
      chunks.push(newline(), fg(FAINT_COLOR)(`↓ ${remaining} more`.padStart(Math.floor(width / 2))))
    } else if (this.scrollOffset > 0) {
      chunks.push(newline(), fg(FAINT_COLOR)("↑ top".padStart(Math.floor(width / 2))))
    }
    return chunks
  }
}

// What each house traded over the range, and the price it traded at.
function distributionTable(distribution: BrokerageDistribution): TableModel {
  return {
    color: VIEW_COLORS[distribution.side],
    barBackground: VIEW_BAR_BACKGROUNDS[distribution.side],
    topCount: distribution.topCount,
    topPercentage: distribution.topPercentage,
    topLots: distribution.topLots,
    otherLots: distribution.otherLots,
    columns: [
      { title: "Net lot", width: 9 },
      { title: "%", width: 5 },
      { title: "Avg", width: 7 },
    ],
    rows: distribution.shares.map((share) => ({
      brokerage: share.brokerage,
      percentage: share.percentage,
      values: [formatLots(share.netLots), formatPercent(share.percentage), formatPrice(share.averagePrice)],
    })),
  }
}

// What each house held once the range settled. A standing position is reported
// as lots alone; a move is reported as the change, in lots and against the
// house's own previous holding.
function settlementTable(analysis: SettlementAnalysis): TableModel {
  const sign = analysis.mode === "LOST" ? "-" : "+"
  const columns: TableColumn[] = analysis.mode === "HELD"
    ? [{ title: "Total lot", width: 11 }, { title: "%", width: 6 }]
    : [{ title: "Δ lot", width: 10 }, { title: "Δ%", width: 8 }, { title: "%", width: 6 }]
  return {
    color: VIEW_COLORS[analysis.mode],
    barBackground: VIEW_BAR_BACKGROUNDS[analysis.mode],
    topCount: analysis.topCount,
    topPercentage: analysis.topPercentage,
    topLots: analysis.topLots,
    otherLots: analysis.otherLots,
    columns,
    rows: analysis.holdings.map((holding) => ({
      brokerage: holding.brokerage,
      percentage: holding.percentage,
      values: analysis.mode === "HELD"
        ? [formatOptionalLots(holding.totalLot), formatPercent(holding.percentage)]
        : [
          formatSigned(holding.lotChange, sign, formatLots),
          formatSigned(holding.percentageChange, sign, formatPercent),
          formatPercent(holding.percentage),
        ],
    })),
  }
}

// The leading houses' combined share against everyone else.
function summaryChunks(table: TableModel, width: number): TextChunk[] {
  const total = table.topLots + table.otherLots
  const label = `Top ${table.topCount} ${formatPercent(table.topPercentage)}`
  const otherLabel = `${formatPercent(100 - table.topPercentage)} Other`
  const fill = total > 0 ? Math.max(0, Math.min(width, Math.round((table.topLots / total) * width))) : 0
  const topLots = formatLots(table.topLots)
  const otherLots = formatLots(table.otherLots)
  return [
    fg(table.color)(label),
    fg(MUTED_COLOR)(" ".repeat(gap(width, label.length, otherLabel.length))),
    fg(OTHER_COLOR)(otherLabel),
    newline(),
    fg(table.color)("█".repeat(fill)),
    fg(OTHER_COLOR)("█".repeat(Math.max(0, width - fill))),
    newline(),
    fg(MUTED_COLOR)(topLots),
    fg(MUTED_COLOR)(" ".repeat(gap(width, topLots.length, otherLots.length))),
    fg(MUTED_COLOR)(otherLots),
  ]
}

// Whatever the figure columns do not claim goes to the house's name, which is
// truncated rather than allowed to push the numbers out of line.
function brokerColumnWidth(columns: TableColumn[], width: number): number {
  const figures = columns.reduce((total, column) => total + column.width + 1, 0)
  return Math.max(MIN_BROKER_WIDTH, width - figures)
}

function headerRow(columns: TableColumn[], brokerWidth: number, width: number): TextChunk[] {
  const segments: Segment[] = [segment("Broker".padEnd(brokerWidth), FAINT_COLOR)]
  for (const column of columns) {
    segments.push(segment(" ", FAINT_COLOR), segment(column.title.padStart(column.width), FAINT_COLOR))
  }
  return plain(padSegments(segments, width, "end"))
}

// Each house's row carries a bar behind its name, scaled against the largest
// share, so the concentration is readable without comparing the numbers.
function valueRow(
  row: TableRow,
  table: TableModel,
  brokerWidth: number,
  width: number,
  maxPercentage: number,
): TextChunk[] {
  const segments: Segment[] = [
    segment(truncate(shortBroker(row.brokerage), brokerWidth).padEnd(brokerWidth), table.color),
  ]
  table.columns.forEach((column, index) => {
    // The first figure is the row's headline, so it keeps the brighter colour.
    segments.push(
      segment(" ", VALUE_COLOR),
      segment((row.values[index] ?? "").padStart(column.width), index === 0 ? VALUE_COLOR : MUTED_COLOR),
    )
  })
  const padded = padSegments(segments, width, "end")
  return shade(padded, 0, barWidth(row.percentage, maxPercentage, brokerWidth), table.barBackground)
}

function gap(width: number, left: number, right: number): number {
  return Math.max(1, width - left - right)
}

function newline(): TextChunk {
  return fg(VALUE_COLOR)("\n")
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatLots(lots: number): string {
  return Math.round(lots).toLocaleString("tr-TR")
}

function formatOptionalLots(lots: number | null): string {
  return lots === null ? "—" : formatLots(lots)
}

function formatPrice(price: number): string {
  return price.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// The direction belongs to the tab, so a move is shown as a magnitude carrying
// that tab's sign rather than however the provider happened to sign it.
function formatSigned(value: number | null, sign: string, format: (value: number) => string): string {
  return value === null ? "—" : `${sign}${format(Math.abs(value))}`
}
