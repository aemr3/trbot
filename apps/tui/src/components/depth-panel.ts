import type { ParsedKey } from "@opentui/core"
import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import {
  DEPTH_TARGETS,
  type DepthBook,
  type DepthLevel,
  type DepthStatus,
  type DepthTarget,
  type DepthTrade,
} from "@trbot/market/depth.ts"
import {
  barWidth,
  padSegments,
  plain,
  segment,
  shade,
  truncate,
  type Segment,
} from "./shaded-row.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const PANEL_BG = TUI_THEME.panelBackground
const HEADING_COLOR = TUI_THEME.textHeading
const MUTED_COLOR = TUI_THEME.textMuted
const FAINT_COLOR = TUI_THEME.textFaint
const VALUE_COLOR = TUI_THEME.textPrimary
const BID_COLOR = TUI_THEME.positive
// The status pair the other panels use: live, or a standing snapshot of it.
const NEUTRAL_COLOR = TUI_THEME.textNeutral
const ASK_COLOR = TUI_THEME.negative
const BID_BAR_BG = TUI_THEME.positiveBar
const ASK_BAR_BG = TUI_THEME.negativeBar
const WARNING_COLOR = TUI_THEME.warning

const ACTIVE_BUTTON_BG = TUI_THEME.activeControl

const PANEL_PADDING = 1
const PRICE_WIDTH = 7
const ORDER_WIDTH = 3
const MIN_LOT_WIDTH = 6
// Order counts are the first thing dropped when the panel is squeezed.
const ORDER_COLUMN_MIN_WIDTH = 42
const LADDER_LEVELS = 10
// Header, blank, ratio block, blank, column header, ladder, blank, trade header.
const FIXED_ROWS = 1 + 1 + 3 + 1 + 1 + LADDER_LEVELS + 1 + 1

export interface DepthPanelInstrument {
  displayName: string
  /** The contract's own symbol, which now has a book of its own. */
  symbol: string
  /** The feed's cash, spot, or index symbol, which has a separate book when available. */
  underlyingSymbol: string | null
  underlyingLabel?: string
}

export interface DepthPanelOptions {
  onFocusRequest?: () => void
  onTargetChange?: (target: DepthTarget) => void
  /** The book the trader was last looking at. */
  initialTarget?: DepthTarget
}

const TARGET_LABELS = {
  UNDERLYING: "Stock",
  INSTRUMENT: "Futures",
} satisfies Record<DepthTarget, string>

// Renders one symbol's order book: the resting buy/sell balance, the price
// ladder either side of the spread, and the trade tape beneath it.
export class DepthPanel {
  readonly root: BoxRenderable

  private readonly header: TextRenderable
  private readonly content: TextRenderable
  private readonly headerRow: BoxRenderable
  private readonly targetButtons = new Map<DepthTarget, BoxRenderable>()
  private readonly targetButtonLabels = new Map<DepthTarget, TextRenderable>()
  private instrument: DepthPanelInstrument | null = null
  private book: DepthBook | null = null
  private status: DepthStatus = "idle"
  private entitled: boolean | null = null
  private target: DepthTarget
  private preferredTarget: DepthTarget
  private availableTargets: DepthTarget[] = [...DEPTH_TARGETS]
  private focused = false
  // Depth is the busiest stream at market open; book events overwrite state
  // and the full-panel rebuild is coalesced per burst.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.root.isDestroyed) this.render()
  })

  constructor(
    renderer: RenderContext,
    private readonly options: DepthPanelOptions = {},
  ) {
    this.target = options.initialTarget ?? "UNDERLYING"
    this.preferredTarget = this.target
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingLeft: PANEL_PADDING,
      paddingRight: PANEL_PADDING,
      backgroundColor: PANEL_BG,
      onSizeChange: () => this.render(),
      onMouseDown: (event) => {
        if (event.button === 0) this.options.onFocusRequest?.()
      },
    })
    this.header = new TextRenderable(renderer, {
      content: "Depth",
      fg: HEADING_COLOR,
      wrapMode: "none",
      flexShrink: 0,
    })
    // Title and book switches share one row, matching the chart's own header so
    // the two panels read as the same control.
    const headerRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      marginBottom: 1,
      overflow: "hidden",
    })
    const targetToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      marginLeft: 1,
      flexShrink: 0,
    })
    for (const target of DEPTH_TARGETS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectTarget(target)
        },
      })
      // Text is selectable by default, so a left click on a label would both
      // press the button and anchor a drag-selection that paints it inverted.
      const label = new TextRenderable(renderer, { content: TARGET_LABELS[target], selectable: false })
      button.add(label)
      targetToolbar.add(button)
      this.targetButtons.set(target, button)
      this.targetButtonLabels.set(target, label)
    }
    headerRow.add(this.header)
    headerRow.add(targetToolbar)
    this.headerRow = headerRow
    this.content = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      width: "100%",
      flexGrow: 1,
      wrapMode: "none",
    })
    this.root.add(this.headerRow)
    this.root.add(this.content)
    this.render()
  }

  // Null while the entitlement check is still in flight, which the panel reports
  // separately from a definite "not subscribed".
  setEntitled(entitled: boolean | null): void {
    if (this.entitled === entitled) return
    this.entitled = entitled
    this.render()
  }

  selectInstrument(instrument: DepthPanelInstrument): void {
    this.instrument = instrument
    this.availableTargets = instrument.underlyingSymbol ? [...DEPTH_TARGETS] : ["INSTRUMENT"]
    this.target = this.availableTargets.includes(this.preferredTarget) ? this.preferredTarget : "INSTRUMENT"
    const underlyingLabel = this.targetButtonLabels.get("UNDERLYING")
    if (underlyingLabel) underlyingLabel.content = instrument.underlyingLabel ?? TARGET_LABELS.UNDERLYING
    this.book = null
    this.status = "idle"
    this.render()
  }

  setStatus(status: DepthStatus): void {
    if (this.status === status) return
    this.status = status
    this.render()
  }

  showBook(book: DepthBook): void {
    // Whichever side the panel is showing: the contract has its own book, and
    // comparing against the underlying alone would drop every one of them.
    if (book.symbol.toUpperCase() !== this.activeSymbol()?.toUpperCase()) return
    this.book = book
    this.liveRender.schedule()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.renderHeader()
  }

  private render(): void {
    this.renderHeader()
    const message = this.messageState()
    if (message) {
      this.content.content = new StyledText([fg(message.color)(message.text)])
      return
    }
    const book = this.book
    if (!book) return

    const width = Math.max(0, this.root.width - PANEL_PADDING * 2)
    const chunks: TextChunk[] = [
      ...ratioChunks(book, width),
      newline(),
      newline(),
      ...ladderChunks(book, width),
      newline(),
      newline(),
      ...tradeChunks(book.trades, width, this.tradeCapacity(), book.marketClosed),
    ]
    this.content.content = new StyledText(chunks)
  }

  /** The symbol whose book is on screen, which the target decides. */
  activeSymbol(): string | null {
    if (!this.instrument) return null
    return this.target === "INSTRUMENT" ? this.instrument.symbol : this.instrument.underlyingSymbol
  }

  setTarget(target: DepthTarget): void {
    if (this.target === target || !this.availableTargets.includes(target)) return
    this.preferredTarget = target
    this.target = target
    // The book on screen belongs to the symbol being left behind.
    this.book = null
    this.status = "idle"
    this.render()
  }

  /**
   * Switches between the stock's book and the contract's.
   *
   * `s` is deliberately not bound: the screen claims it for the sell ticket
   * before a panel ever sees it.
   */
  handleKey(key: ParsedKey): boolean {
    const toggle = key.sequence === "f" || key.name === "left" || key.name === "right"
      || key.name === "h" || key.name === "l"
    if (!toggle) return false
    if (this.availableTargets.length > 1) {
      this.selectTarget(this.target === "UNDERLYING" ? "INSTRUMENT" : "UNDERLYING")
    }
    return true
  }

  private selectTarget(target: DepthTarget): void {
    if (this.target === target || !this.availableTargets.includes(target)) return
    this.setTarget(target)
    this.options.onTargetChange?.(target)
  }

  private renderHeader(): void {
    const titleColor = this.focused ? TUI_THEME.textStrong : FAINT_COLOR
    // The instrument is not named here: the switches say which book is showing,
    // and the chart beside this panel already carries the ticker.
    if (!this.activeSymbol()) {
      this.header.content = new StyledText([fg(titleColor)("Depth")])
      this.paintTargets()
      return
    }
    // The connection and the market are different questions: the socket can be
    // live on a symbol whose session ended hours ago, and saying "live" over an
    // empty ladder would read as a fault.
    const closed = this.book?.marketClosed === true
    const live = this.status === "live" && !closed
    const state = closed ? "○ closed" : live ? "● live" : "○ snapshot"
    this.header.content = new StyledText([
      fg(titleColor)("Depth"),
      fg(MUTED_COLOR)("  "),
      fg(live ? BID_COLOR : NEUTRAL_COLOR)(state),
    ])
    this.paintTargets()
  }

  /** Paints the switches the way the chart paints its own. */
  private paintTargets(): void {
    for (const target of DEPTH_TARGETS) {
      const selected = this.target === target
      const button = this.targetButtons.get(target)
      const label = this.targetButtonLabels.get(target)
      if (!button || !label) continue
      button.visible = this.availableTargets.includes(target)
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : undefined
      label.fg = selected ? TUI_THEME.textStrong : this.focused ? TUI_THEME.textSecondary : TUI_THEME.textFaint
    }
  }

  // The one message that stands in for the whole book, or null when there is a
  // book worth drawing.
  private messageState(): { text: string; color: string } | null {
    if (this.entitled === null) return { text: "Checking market depth access…", color: MUTED_COLOR }
    if (!this.entitled) {
      return {
        text: "Market depth is a paid feature and is not enabled\non this account.",
        color: WARNING_COLOR,
      }
    }
    if (!this.instrument) return { text: "Select a VIOP contract.", color: MUTED_COLOR }
    const symbol = this.activeSymbol()
    if (!symbol) {
      return { text: `${this.instrument.displayName} has no market-data symbol for this view.`, color: MUTED_COLOR }
    }
    if (this.status === "unavailable") {
      return { text: `No depth book for ${symbol}.`, color: MUTED_COLOR }
    }
    if (!this.book) return { text: "Loading depth…", color: MUTED_COLOR }
    // A closed market is not a missing book: the exchange has cleared every level
    // and that is what an empty ladder means. It draws as the empty scaffold, with
    // the header saying why, rather than as a sentence where the book should be.
    return null
  }

  private tradeCapacity(): number {
    return Math.max(0, this.root.height - FIXED_ROWS)
  }
}

// Resting buy volume against resting sell volume: the share each side holds, a
// proportional bar, and the raw lot totals behind it.
function ratioChunks(book: DepthBook, width: number): TextChunk[] {
  const buy = book.buyLots ?? 0
  const sell = book.sellLots ?? 0
  const total = buy + sell
  if (total <= 0) {
    // Nothing resting on either side — a closed market, or a session whose totals
    // have not arrived. The block keeps its three lines so the ladder beneath does
    // not jump when they do, and the gauge is drawn as an empty track.
    const labels = { buy: "Buy", sell: "Sell", none: "—" }
    return [
      fg(FAINT_COLOR)(labels.buy),
      fg(FAINT_COLOR)(" ".repeat(gap(width, labels.buy.length, labels.sell.length))),
      fg(FAINT_COLOR)(labels.sell),
      newline(),
      fg(FAINT_COLOR)("─".repeat(Math.max(0, width))),
      newline(),
      fg(FAINT_COLOR)(labels.none),
      fg(FAINT_COLOR)(" ".repeat(gap(width, labels.none.length, labels.none.length))),
      fg(FAINT_COLOR)(labels.none),
    ]
  }

  const buyShare = buy / total
  const buyLabel = `Buy ${formatPercent(buyShare)}`
  const sellLabel = `${formatPercent(1 - buyShare)} Sell`
  const buyFill = Math.max(0, Math.min(width, Math.round(width * buyShare)))
  return [
    fg(BID_COLOR)(buyLabel),
    fg(MUTED_COLOR)(" ".repeat(gap(width, buyLabel.length, sellLabel.length))),
    fg(ASK_COLOR)(sellLabel),
    newline(),
    fg(BID_COLOR)("█".repeat(buyFill)),
    fg(ASK_COLOR)("█".repeat(Math.max(0, width - buyFill))),
    newline(),
    fg(MUTED_COLOR)(formatLots(buy)),
    fg(MUTED_COLOR)(" ".repeat(gap(width, formatLots(buy).length, formatLots(sell).length))),
    fg(MUTED_COLOR)(formatLots(sell)),
  ]
}

// The two sides of the ladder sit either side of a spread rule, each rung shaded
// in proportion to the lots resting on it so size stands out at a glance.
function ladderChunks(book: DepthBook, width: number): TextChunk[] {
  const sideWidth = Math.max(1, Math.floor((width - 1) / 2))
  const showOrders = width >= ORDER_COLUMN_MIN_WIDTH
  const lotWidth = Math.max(MIN_LOT_WIDTH, sideWidth - PRICE_WIDTH - 1 - (showOrders ? ORDER_WIDTH + 1 : 0))
  const maxLots = Math.max(
    1,
    ...book.bids.slice(0, LADDER_LEVELS).map((level) => level.lots),
    ...book.asks.slice(0, LADDER_LEVELS).map((level) => level.lots),
  )

  const chunks: TextChunk[] = [
    ...headerRow(sideWidth, lotWidth, showOrders),
  ]
  for (let index = 0; index < LADDER_LEVELS; index++) {
    chunks.push(newline())
    const bid = book.bids[index] ?? null
    const ask = book.asks[index] ?? null
    chunks.push(...bidRow(bid, sideWidth, lotWidth, showOrders, maxLots))
    chunks.push(fg(FAINT_COLOR)("│"))
    chunks.push(...askRow(ask, sideWidth, lotWidth, showOrders, maxLots))
  }
  return chunks
}

function headerRow(sideWidth: number, lotWidth: number, showOrders: boolean): TextChunk[] {
  const bidLabels: Segment[] = [
    ...(showOrders ? [segment("Ord".padStart(ORDER_WIDTH), FAINT_COLOR), segment(" ", FAINT_COLOR)] : []),
    segment("Lot".padStart(lotWidth), FAINT_COLOR),
    segment(" ", FAINT_COLOR),
    segment("Bid".padStart(PRICE_WIDTH), FAINT_COLOR),
  ]
  // Labels follow their columns: the ask price hugs the spread while its lot and
  // order counts stay right-aligned like the values beneath them.
  const askLabels: Segment[] = [
    segment("Ask".padEnd(PRICE_WIDTH), FAINT_COLOR),
    segment(" ", FAINT_COLOR),
    segment("Lot".padStart(lotWidth), FAINT_COLOR),
    ...(showOrders ? [segment(" ", FAINT_COLOR), segment("Ord".padStart(ORDER_WIDTH), FAINT_COLOR)] : []),
  ]
  return [
    ...plain(padSegments(bidLabels, sideWidth, "start")),
    fg(FAINT_COLOR)("│"),
    ...plain(padSegments(askLabels, sideWidth, "end")),
  ]
}

// Bids read right-to-left into the spread, so the size bar grows leftward from
// the price column.
function bidRow(
  level: DepthLevel | null,
  sideWidth: number,
  lotWidth: number,
  showOrders: boolean,
  maxLots: number,
): TextChunk[] {
  const segments: Segment[] = level
    ? [
        ...(showOrders
          ? [segment(String(level.orderCount).padStart(ORDER_WIDTH), MUTED_COLOR), segment(" ", MUTED_COLOR)]
          : []),
        segment(formatLots(level.lots).padStart(lotWidth), VALUE_COLOR),
        segment(" ", VALUE_COLOR),
        segment(formatPrice(level.price).padStart(PRICE_WIDTH), BID_COLOR),
      ]
    : [segment("", MUTED_COLOR)]
  const padded = padSegments(segments, sideWidth, "start")
  const fill = level ? barWidth(level.lots, maxLots, sideWidth) : 0
  return shade(padded, sideWidth - fill, sideWidth, BID_BAR_BG)
}

// Asks read left-to-right away from the spread, so their bar grows rightward.
function askRow(
  level: DepthLevel | null,
  sideWidth: number,
  lotWidth: number,
  showOrders: boolean,
  maxLots: number,
): TextChunk[] {
  const segments: Segment[] = level
    ? [
        segment(formatPrice(level.price).padEnd(PRICE_WIDTH), ASK_COLOR),
        segment(" ", VALUE_COLOR),
        segment(formatLots(level.lots).padStart(lotWidth), VALUE_COLOR),
        ...(showOrders
          ? [segment(" ", MUTED_COLOR), segment(String(level.orderCount).padStart(ORDER_WIDTH), MUTED_COLOR)]
          : []),
      ]
    : [segment("", MUTED_COLOR)]
  const padded = padSegments(segments, sideWidth, "end")
  return shade(padded, 0, level ? barWidth(level.lots, maxLots, sideWidth) : 0, ASK_BAR_BG)
}

function tradeChunks(trades: DepthTrade[], width: number, capacity: number, marketClosed: boolean): TextChunk[] {
  const chunks: TextChunk[] = [fg(HEADING_COLOR)("Trades")]
  if (capacity <= 0) return chunks
  if (trades.length === 0) {
    // The tape is per session and empties at the boundary, so after the close
    // there is nothing still to come.
    chunks.push(newline(), fg(MUTED_COLOR)(marketClosed ? "No trades." : "No trades yet."))
    return chunks
  }
  const counterpartyWidth = Math.max(0, width - PRICE_WIDTH - 1 - 8 - 1)
  for (const trade of trades.slice(0, capacity)) {
    const color = trade.side === "BUY" ? BID_COLOR : ASK_COLOR
    chunks.push(
      newline(),
      fg(color)(formatPrice(trade.price).padStart(PRICE_WIDTH)),
      fg(VALUE_COLOR)(` ${formatLots(trade.lots).padStart(8)}`),
      fg(MUTED_COLOR)(` ${counterparties(trade, counterpartyWidth)}`),
    )
  }
  return chunks
}

// "buyer ← seller": the arrow points at where the shares came from.
function counterparties(trade: DepthTrade, width: number): string {
  return truncate(`${shortBroker(trade.buyer)} ← ${shortBroker(trade.seller)}`, width)
}

// Broker names are long and mostly boilerplate ("Garanti Yatırım Menkul
// Kıymetler"); the distinguishing part is the leading house name.
export function shortBroker(name: string | null): string {
  if (!name) return "—"
  const trimmed = name.split(/\s+(?:Yatırım|Menkul)\b/)[0] ?? name
  return trimmed.trim() || name.trim()
}

function gap(width: number, left: number, right: number): number {
  return Math.max(1, width - left - right)
}

function newline(): TextChunk {
  return fg(VALUE_COLOR)("\n")
}

function formatPercent(share: number): string {
  return `${(share * 100).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatLots(lots: number): string {
  return Math.round(lots).toLocaleString("tr-TR")
}

function formatPrice(price: number): string {
  return price.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
