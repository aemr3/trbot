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
  type BrokerageDateRange,
  type BrokerageDistribution,
  type BrokerageShare,
  type BrokerageSide,
} from "../market/brokerage.ts"
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
const BUY_BAR_BG = "#16311f"
const SELL_BAR_BG = "#3a1f1f"
const OTHER_COLOR = "#777777"
const SELECTED_TAB_BG = "#282828"
const WARNING_COLOR = "#e5c07b"

const PANEL_PADDING = 1
const LOTS_WIDTH = 9
const PERCENT_WIDTH = 5
const PRICE_WIDTH = 7
const MIN_BROKER_WIDTH = 8
// Top border, tab row, blank, the three summary lines, blank, column header.
const FIXED_ROWS = 1 + 1 + 1 + 3 + 1 + 1

const SIDES: BrokerageSide[] = ["BUYER", "SELLER"]
const SIDE_LABELS: Record<BrokerageSide, string> = { BUYER: "Buyers", SELLER: "Sellers" }

export interface BrokeragePanelOptions {
  onSideChange?: (side: BrokerageSide) => void
  onOpenDateRange?: () => void
  onFocusRequest?: () => void
}

// Shows which brokerage houses accumulated or distributed the underlying stock
// over a date range: the leading houses' combined share, then every house ranked
// by net lots with its average price.
export class BrokeragePanel {
  readonly root: BoxRenderable

  private readonly title: TextRenderable
  private readonly sideButtons = new Map<BrokerageSide, BoxRenderable>()
  private readonly sideButtonLabels = new Map<BrokerageSide, TextRenderable>()
  private readonly rangeLabel: TextRenderable
  private readonly content: TextRenderable
  private side: BrokerageSide = "BUYER"
  private distribution: BrokerageDistribution | null = null
  private range: BrokerageDateRange = { start: null, end: null }
  private message: { text: string; color: string } | null = null
  private entitled: boolean | null = null
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
    // The tabs are real boxes rather than styled text so they can be clicked as
    // well as cycled with the arrow keys.
    const toolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
      marginBottom: 1,
    })
    this.title = new TextRenderable(renderer, { content: "Brokers", fg: FAINT_COLOR, marginRight: 1 })
    toolbar.add(this.title)
    for (const side of SIDES) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectSide(side)
        },
      })
      const label = new TextRenderable(renderer, { content: SIDE_LABELS[side] })
      button.add(label)
      toolbar.add(button)
      this.sideButtons.set(side, button)
      this.sideButtonLabels.set(side, label)
    }
    toolbar.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1 }))
    this.rangeLabel = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      onMouseDown: (event) => {
        if (event.button !== 0) return
        this.options.onFocusRequest?.()
        this.options.onOpenDateRange?.()
      },
    })
    toolbar.add(this.rangeLabel)
    this.content = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      width: "100%",
      flexGrow: 1,
      wrapMode: "none",
    })
    this.root.add(toolbar)
    this.root.add(this.content)
    this.render()
  }

  get activeSide(): BrokerageSide {
    return this.side
  }

  setEntitled(entitled: boolean | null): void {
    if (this.entitled === entitled) return
    this.entitled = entitled
    this.render()
  }

  // Clears the table for a new contract while the first load is in flight.
  reset(): void {
    this.distribution = null
    this.scrollOffset = 0
    this.message = null
    this.render()
  }

  setRange(range: BrokerageDateRange): void {
    this.range = range
    this.render()
  }

  showDistribution(distribution: BrokerageDistribution): void {
    if (distribution.side !== this.side) return
    this.distribution = distribution
    this.message = null
    this.clampScroll()
    this.render()
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
      this.selectSide(SIDES[(SIDES.indexOf(this.side) + direction + SIDES.length) % SIDES.length] ?? "BUYER")
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

  private selectSide(side: BrokerageSide): void {
    if (this.side === side) return
    this.side = side
    this.distribution = null
    this.scrollOffset = 0
    this.render()
    this.options.onSideChange?.(side)
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
    const distribution = this.distribution
    if (!distribution) return 0
    const layout = this.tableLayout(distribution)
    return Math.max(0, layout.tail.length - layout.visibleTail)
  }

  private render(): void {
    this.renderTabs()
    const message = this.messageState()
    if (message) {
      this.content.content = new StyledText([fg(message.color)(message.text)])
      return
    }
    const distribution = this.distribution
    if (!distribution) return

    const width = this.contentWidth()
    this.content.content = new StyledText([
      ...summaryChunks(distribution, width),
      newline(),
      newline(),
      ...this.tableChunks(distribution, width),
    ])
  }

  private renderTabs(): void {
    this.title.fg = this.focused ? "#ffffff" : FAINT_COLOR
    for (const side of SIDES) {
      const active = this.side === side
      const button = this.sideButtons.get(side)
      const label = this.sideButtonLabels.get(side)
      if (!button || !label) continue
      button.backgroundColor = active ? SELECTED_TAB_BG : undefined
      label.fg = active ? sideColor(side) : this.focused ? "#aaaaaa" : FAINT_COLOR
    }
    this.rangeLabel.content = describeRange(this.range, this.distribution?.presets ?? [])
    this.rangeLabel.fg = this.focused ? HEADING_COLOR : MUTED_COLOR
  }

  private messageState(): { text: string; color: string } | null {
    if (this.entitled === null) return { text: "Checking broker distribution access…", color: MUTED_COLOR }
    if (!this.entitled) {
      return { text: "Broker distribution is a paid feature and is\nnot enabled on this account.", color: WARNING_COLOR }
    }
    if (this.message) return this.message
    if (!this.distribution) return { text: "Loading broker distribution…", color: MUTED_COLOR }
    if (this.distribution.shares.length === 0) return { text: "No broker activity in this range.", color: MUTED_COLOR }
    return null
  }

  private contentWidth(): number {
    return Math.max(0, this.root.width - PANEL_PADDING * 2)
  }

  // Splits the ranked houses into the leading group, which stays pinned, and the
  // scrollable tail beneath it.
  private tableLayout(distribution: BrokerageDistribution) {
    const capacity = Math.max(0, this.root.height - FIXED_ROWS)
    const topCount = Math.min(distribution.topCount, distribution.shares.length)
    const top = distribution.shares.slice(0, Math.min(topCount, capacity))
    const tail = distribution.shares.slice(topCount)
    // The divider only earns its row when there is a tail to separate.
    const afterTop = Math.max(0, capacity - top.length - (tail.length > 0 ? 1 : 0))
    const needsIndicator = tail.length > afterTop
    const visibleTail = Math.max(0, needsIndicator ? afterTop - 1 : afterTop)
    return { top, tail, visibleTail, showDivider: tail.length > 0 && capacity > top.length }
  }

  private tableChunks(distribution: BrokerageDistribution, width: number): TextChunk[] {
    const brokerWidth = Math.max(MIN_BROKER_WIDTH, width - LOTS_WIDTH - PERCENT_WIDTH - PRICE_WIDTH - 3)
    const maxPercentage = Math.max(1, ...distribution.shares.map((share) => share.percentage))
    const layout = this.tableLayout(distribution)
    const chunks: TextChunk[] = [...headerRow(brokerWidth, width)]

    for (const share of layout.top) {
      chunks.push(newline(), ...shareRow(share, this.side, brokerWidth, width, maxPercentage))
    }
    if (layout.showDivider) chunks.push(newline(), fg(FAINT_COLOR)("─".repeat(width)))

    const visible = layout.tail.slice(this.scrollOffset, this.scrollOffset + layout.visibleTail)
    for (const share of visible) {
      chunks.push(newline(), ...shareRow(share, this.side, brokerWidth, width, maxPercentage))
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

// The leading houses' combined share against everyone else.
function summaryChunks(distribution: BrokerageDistribution, width: number): TextChunk[] {
  const total = distribution.topLots + distribution.otherLots
  const side = distribution.side
  const label = `Top ${distribution.topCount} ${formatPercent(distribution.topPercentage)}`
  const otherLabel = `${formatPercent(100 - distribution.topPercentage)} Other`
  const fill = total > 0
    ? Math.max(0, Math.min(width, Math.round((distribution.topLots / total) * width)))
    : 0
  const topLots = formatLots(distribution.topLots)
  const otherLots = formatLots(distribution.otherLots)
  return [
    fg(sideColor(side))(label),
    fg(MUTED_COLOR)(" ".repeat(gap(width, label.length, otherLabel.length))),
    fg(OTHER_COLOR)(otherLabel),
    newline(),
    fg(sideColor(side))("█".repeat(fill)),
    fg(OTHER_COLOR)("█".repeat(Math.max(0, width - fill))),
    newline(),
    fg(MUTED_COLOR)(topLots),
    fg(MUTED_COLOR)(" ".repeat(gap(width, topLots.length, otherLots.length))),
    fg(MUTED_COLOR)(otherLots),
  ]
}

function headerRow(brokerWidth: number, width: number): TextChunk[] {
  return plain(padSegments([
    segment("Broker".padEnd(brokerWidth), FAINT_COLOR),
    segment(" ", FAINT_COLOR),
    segment("Net lot".padStart(LOTS_WIDTH), FAINT_COLOR),
    segment(" ", FAINT_COLOR),
    segment("%".padStart(PERCENT_WIDTH), FAINT_COLOR),
    segment(" ", FAINT_COLOR),
    segment("Avg".padStart(PRICE_WIDTH), FAINT_COLOR),
  ], width, "end"))
}

// Each house's row carries a bar behind its name, scaled against the largest
// share, so the concentration is readable without comparing the numbers.
function shareRow(
  share: BrokerageShare,
  side: BrokerageSide,
  brokerWidth: number,
  width: number,
  maxPercentage: number,
): TextChunk[] {
  const segments: Segment[] = [
    segment(truncate(shortBroker(share.brokerage), brokerWidth).padEnd(brokerWidth), sideColor(side)),
    segment(" ", VALUE_COLOR),
    segment(formatLots(share.netLots).padStart(LOTS_WIDTH), VALUE_COLOR),
    segment(" ", VALUE_COLOR),
    segment(formatPercent(share.percentage).padStart(PERCENT_WIDTH), MUTED_COLOR),
    segment(" ", VALUE_COLOR),
    segment(formatPrice(share.averagePrice).padStart(PRICE_WIDTH), MUTED_COLOR),
  ]
  const padded = padSegments(segments, width, "end")
  return shade(padded, 0, barWidth(share.percentage, maxPercentage, brokerWidth), sideBarBackground(side))
}

function sideColor(side: BrokerageSide): string {
  return side === "BUYER" ? BUY_COLOR : SELL_COLOR
}

function sideBarBackground(side: BrokerageSide): string {
  return side === "BUYER" ? BUY_BAR_BG : SELL_BAR_BG
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

function formatPrice(price: number): string {
  return price.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
