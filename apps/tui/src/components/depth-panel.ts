import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { DepthBook, DepthLevel, DepthStatus, DepthTrade } from "@trbot/market/depth.ts"
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

const PANEL_BG = "#161616"
const HEADING_COLOR = "#eeeeee"
const MUTED_COLOR = "#888888"
const FAINT_COLOR = "#666666"
const VALUE_COLOR = "#dddddd"
const BID_COLOR = "#70d7a1"
const ASK_COLOR = "#ff6b6b"
const BID_BAR_BG = "#16311f"
const ASK_BAR_BG = "#3a1f1f"
const WARNING_COLOR = "#e5c07b"

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
  // The underlying stock symbol; VIOP contracts have no book of their own.
  underlyingSymbol: string | null
}

export interface DepthPanelOptions {
  onFocusRequest?: () => void
}

// Renders one symbol's order book: the resting buy/sell balance, the price
// ladder either side of the spread, and the trade tape beneath it.
export class DepthPanel {
  readonly root: BoxRenderable

  private readonly header: TextRenderable
  private readonly content: TextRenderable
  private instrument: DepthPanelInstrument | null = null
  private book: DepthBook | null = null
  private status: DepthStatus = "idle"
  private entitled: boolean | null = null
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
      marginBottom: 1,
      wrapMode: "none",
    })
    this.content = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      width: "100%",
      flexGrow: 1,
      wrapMode: "none",
    })
    this.root.add(this.header)
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
    this.book = null
    this.render()
  }

  setStatus(status: DepthStatus): void {
    if (this.status === status) return
    this.status = status
    this.render()
  }

  showBook(book: DepthBook): void {
    if (book.symbol.toUpperCase() !== this.instrument?.underlyingSymbol?.toUpperCase()) return
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
      ...tradeChunks(book.trades, width, this.tradeCapacity()),
    ]
    this.content.content = new StyledText(chunks)
  }

  private renderHeader(): void {
    const titleColor = this.focused ? "#ffffff" : FAINT_COLOR
    const symbol = this.instrument?.underlyingSymbol
    if (!symbol) {
      this.header.content = new StyledText([fg(titleColor)("Depth")])
      return
    }
    const live = this.status === "live"
    this.header.content = new StyledText([
      fg(titleColor)("Depth"),
      fg(MUTED_COLOR)("  "),
      fg(HEADING_COLOR)(symbol),
      fg(MUTED_COLOR)("  "),
      fg(live ? BID_COLOR : MUTED_COLOR)(live ? "● live" : "○ —"),
    ])
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
    if (!this.instrument.underlyingSymbol) {
      return { text: `${this.instrument.displayName} has no underlying stock.`, color: MUTED_COLOR }
    }
    if (this.status === "unavailable") {
      return { text: `No depth book for ${this.instrument.underlyingSymbol}.`, color: MUTED_COLOR }
    }
    if (!this.book) return { text: "Loading depth…", color: MUTED_COLOR }
    if (this.book.maintenance) return { text: "Market data provider is in maintenance.", color: WARNING_COLOR }
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
  if (total <= 0) return [fg(MUTED_COLOR)("Buy / sell balance unavailable")]

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

function tradeChunks(trades: DepthTrade[], width: number, capacity: number): TextChunk[] {
  const chunks: TextChunk[] = [fg(HEADING_COLOR)("Trades")]
  if (capacity <= 0) return chunks
  if (trades.length === 0) {
    chunks.push(newline(), fg(MUTED_COLOR)("No trades yet."))
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
