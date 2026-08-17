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
  PORTFOLIO_RANGES,
  PORTFOLIO_RANGE_LABELS,
  PORTFOLIO_RANGE_METRIC_LABELS,
  type PortfolioPerformance,
  type PortfolioPoint,
  type PortfolioRange,
  type PortfolioSummary,
} from "../trading/account.ts"
import { renderBarBitmap } from "./chart/bar-raster.ts"
import { ChartBitmapRenderable, chartBitmapSupport } from "./chart/bitmap-renderable.ts"
import { KittyPlaceholderImages } from "./chart/kitty-placeholder.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

// What the account is worth, how it is doing, and how it got there. It stands
// permanently under the instrument list rather than behind a tab: every sizing
// decision is made against these numbers.

const PANEL_BG = "#161616"
const ACTIVE_BUTTON_BG = "#333333"
const HEADING_COLOR = "#eeeeee"
const FOCUSED_COLOR = "#ffffff"
const UNFOCUSED_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const UP_COLOR = "#70d7a1"
const ZERO_LINE_COLOR = "#505050"
const DOWN_COLOR = "#ff6b6b"

// Rows above and below the zero line. The provider serves at most six points
// for any range, so the bars stay wide enough to read at this height.
const BAR_ROWS = 3
// Half-row granularity, drawn with plain Block Elements. The eighth-height
// glyphs would read better but only exist pointing up; their downward twins
// live in Symbols for Legacy Computing, which most terminals lack.
const HALF_STEPS = 2
// A gain grows up from the zero line, so a part-filled row sits at its bottom.
const UP_BLOCKS = ["", "▄", "█"] as const
// A loss hangs down from it, so a part-filled row sits at its top.
const DOWN_BLOCKS = ["", "▀", "█"] as const

export interface PortfolioPanelOptions {
  onFocusRequest?: () => void
  // The panel picks a range and reports it; the screen owns the reload.
  onRangeChange?: (range: PortfolioRange) => void
}

export class PortfolioPanel {
  readonly root: BoxRenderable

  private readonly metrics: TextRenderable
  private readonly barsText: TextRenderable
  private readonly barsBitmap: ChartBitmapRenderable
  private readonly labels: TextRenderable
  private readonly rangeButtons = new Map<PortfolioRange, BoxRenderable>()
  private readonly rangeLabels = new Map<PortfolioRange, TextRenderable>()
  private portfolio: PortfolioSummary | null = null
  private performance: PortfolioPerformance | null = null
  private range: PortfolioRange = "WEEK"
  private focused = false
  // Created lazily when running inside tmux with kitty graphics passthrough.
  private placeholderImages: KittyPlaceholderImages | null = null
  // Kitty support is discovered asynchronously; redraw when the terminal
  // answers so the bars upgrade from blocks to true pixels.
  private readonly handleCapabilities = () => this.liveRender.schedule()
  // Collateral moves with every fill, so updates arrive in bursts.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.root.isDestroyed) this.render()
  })

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: PortfolioPanelOptions = {},
  ) {
    this.root = new BoxRenderable(renderer, {
      // The range header, a blank row, four figures, another blank row, the
      // bars around their zero line, and the day under each one.
      height: 16,
      flexShrink: 0,
      flexDirection: "column",
      border: ["top"],
      borderColor: "#303030",
      backgroundColor: PANEL_BG,
      onMouseDown: (event) => {
        if (event.button === 0) this.options.onFocusRequest?.()
      },
      onSizeChange: () => this.render(),
    })

    // The blank row keeps the range chips off the figures they filter, and the
    // right padding keeps the selected chip's highlight off the panel's edge.
    // A sidebar too narrow for both cuts the header off at its own edge rather
    // than painting the chips over the panel beside it.
    const header = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      marginBottom: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    // The chips are what the header is for, so the title is what gives way when
    // the sidebar narrows.
    header.add(new TextRenderable(renderer, {
      content: "Portfolio",
      fg: HEADING_COLOR,
      flexShrink: 1,
      marginRight: 1,
      wrapMode: "none",
    }))
    // Pushes the ranges to the right edge, clear of the title's highlight.
    header.add(new BoxRenderable(renderer, { flexGrow: 1 }))
    for (const range of PORTFOLIO_RANGES) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectRange(range)
        },
      })
      const label = new TextRenderable(renderer, { content: PORTFOLIO_RANGE_LABELS[range], wrapMode: "none" })
      button.add(label)
      header.add(button)
      this.rangeButtons.set(range, button)
      this.rangeLabels.set(range, label)
    }

    this.metrics = new TextRenderable(renderer, {
      content: "Loading account…",
      fg: MUTED_COLOR,
      width: "100%",
      height: 4,
      flexShrink: 0,
      marginBottom: 1,
      wrapMode: "none",
    })
    this.barsText = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexGrow: 1,
      wrapMode: "none",
      onSizeChange: () => this.liveRender.schedule(),
    })
    this.barsBitmap = new ChartBitmapRenderable(renderer, { width: "100%", flexGrow: 1, visible: false })
    this.labels = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      height: 1,
      flexShrink: 0,
      fg: MUTED_COLOR,
      wrapMode: "none",
    })
    this.root.add(header)
    this.root.add(this.metrics)
    this.root.add(this.barsText)
    this.root.add(this.barsBitmap)
    this.root.add(this.labels)
    this.paintRanges()
    this.renderer.on("capabilities", this.handleCapabilities)
  }

  destroy(): void {
    this.liveRender.cancel()
    this.renderer.off("capabilities", this.handleCapabilities)
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.paintRanges()
  }

  /** The range whose performance is being shown, for the account reload. */
  get activeRange(): PortfolioRange {
    return this.range
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l") {
      const step = key.name === "left" || key.name === "h" ? -1 : 1
      const index = PORTFOLIO_RANGES.indexOf(this.range)
      this.selectRange(PORTFOLIO_RANGES[(index + step + PORTFOLIO_RANGES.length) % PORTFOLIO_RANGES.length] ?? "WEEK")
      return true
    }
    return false
  }

  showPortfolio(portfolio: PortfolioSummary): void {
    this.portfolio = portfolio
    if (!this.root.isDestroyed) this.liveRender.schedule()
  }

  showPerformance(performance: PortfolioPerformance): void {
    this.performance = performance
    if (!this.root.isDestroyed) this.liveRender.schedule()
  }

  /** Says so plainly rather than leaving a stale figure to be sized against. */
  showUnavailable(): void {
    this.portfolio = null
    this.performance = null
    this.metrics.content = "Account data is unavailable."
    this.metrics.fg = MUTED_COLOR
    this.showBarMessage("")
  }

  private selectRange(range: PortfolioRange): void {
    if (this.range === range) return
    this.range = range
    // The old range's bars must not sit under a new range's label.
    this.performance = null
    this.paintRanges()
    this.render()
    this.options.onRangeChange?.(range)
  }

  private paintRanges(): void {
    for (const range of PORTFOLIO_RANGES) {
      const selected = range === this.range
      const button = this.rangeButtons.get(range)
      const label = this.rangeLabels.get(range)
      if (!button || !label) continue
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : PANEL_BG
      label.fg = selected ? FOCUSED_COLOR : this.focused ? MUTED_COLOR : UNFOCUSED_COLOR
    }
  }

  private render(): void {
    const portfolio = this.portfolio
    if (!portfolio) return
    const dayColor = (portfolio.dailyProfitLoss ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
    const performance = this.performance
    const periodValue = performance?.profitLoss ?? null
    const periodPercent = performance?.profitLossPercent ?? null
    const periodColor = (periodValue ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR
    const chunks: TextChunk[] = [
      ...metric("Collateral", formatMoney(portfolio.totalCollateral, portfolio.currency)),
      newline(),
      ...metric("Available", formatMoney(portfolio.availableCollateral, portfolio.currency)),
      newline(),
      ...metric("Day P/L", formatProfit(portfolio.dailyProfitLoss, portfolio.dailyProfitLossPercent, portfolio.currency), dayColor),
      newline(),
      ...metric(
        PORTFOLIO_RANGE_METRIC_LABELS[this.range],
        formatProfit(periodValue, periodPercent, portfolio.currency),
        periodColor,
      ),
    ]
    this.metrics.content = new StyledText(chunks)
    this.metrics.fg = VALUE_COLOR
    this.renderBars()
  }

  /**
   * Draws the bars as true pixels where the terminal can, and as block glyphs
   * where it cannot. Blocks quantize a bar to half a row, so at this height a
   * quiet day and a middling one look the same; pixels give every bar the
   * height it actually has.
   */
  private renderBars(): void {
    const performance = this.performance
    if (!performance) return this.showBarMessage("Loading performance…")
    const points = performance.points
    if (points.length === 0) return this.showBarMessage("No performance history for this range.")
    if (points.every((point) => (point.profitLoss ?? 0) === 0)) return this.showBarMessage("Flat across this range.")

    const columns = Math.max(1, this.barsText.width || this.root.width)
    const rows = Math.max(1, this.barsText.height)
    const support = chartBitmapSupport(this.renderer)
    if (support) {
      const bitmap = renderBarBitmap({
        bars: points.map((point) => ({ value: point.profitLoss ?? 0, label: point.date })),
        width: Math.max(1, Math.round(columns * support.cellPixel.width)),
        height: Math.max(1, Math.round(rows * support.cellPixel.height)),
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        zeroColor: ZERO_LINE_COLOR,
      })
      if (support.mode === "placeholder") {
        // Kitty payloads must go through the renderer's serialized write queue;
        // a raw stdout write races the render thread mid-frame.
        this.placeholderImages ??= new KittyPlaceholderImages((data) =>
          (this.renderer as unknown as { writeOut(data: string): void }).writeOut(data),
        )
        this.barsText.content = this.placeholderImages.render(bitmap, columns, rows)
        this.barsText.visible = true
        this.barsBitmap.visible = false
        this.barsBitmap.setBitmap(null)
      } else {
        this.barsBitmap.setBitmap(bitmap)
        this.barsBitmap.visible = true
        this.barsText.visible = false
      }
    } else {
      this.barsText.content = new StyledText(performanceChunks(performance, columns))
      this.barsText.visible = true
      this.barsBitmap.visible = false
      this.barsBitmap.setBitmap(null)
    }
    this.labels.content = new StyledText(axisLabels(points, barWidth(points.length, columns)))
  }

  private showBarMessage(message: string): void {
    this.barsText.content = message
    this.barsText.fg = MUTED_COLOR
    this.barsText.visible = true
    this.barsBitmap.visible = false
    this.barsBitmap.setBitmap(null)
    this.labels.content = ""
  }
}

/**
 * The range's bars, drawn around a zero line: gains rise from it, losses hang
 * below it. Both halves are scaled by the same worst-case magnitude so a small
 * loss beside a large gain reads as small.
 */
export function performanceChunks(performance: PortfolioPerformance, width: number): TextChunk[] {
  const points = performance.points
  const peak = Math.max(...points.map((point) => Math.abs(point.profitLoss ?? 0)))
  if (points.length === 0 || peak <= 0) return []
  const columns = barWidth(points.length, width)
  const rows: TextChunk[] = []

  // Gains first, from the tallest row down to the zero line.
  for (let row = BAR_ROWS; row >= 1; row--) {
    rows.push(...barRow(points, columns, row, "UP", peak), newline())
  }
  rows.push(fg(ZERO_LINE_COLOR)("─".repeat(Math.min(width, columns * points.length))), newline())
  for (let row = 1; row <= BAR_ROWS; row++) {
    rows.push(...barRow(points, columns, row, "DOWN", peak), newline())
  }
  return rows
}

/** One row of the bar field, `row` steps away from the zero line. */
function barRow(
  points: PortfolioPoint[],
  columns: number,
  row: number,
  direction: "UP" | "DOWN",
  peak: number,
): TextChunk[] {
  const blocks = direction === "UP" ? UP_BLOCKS : DOWN_BLOCKS
  return points.map((point) => {
    const value = point.profitLoss ?? 0
    const wanted = direction === "UP" ? value : -value
    if (wanted <= 0) return fg(MUTED_COLOR)(" ".repeat(columns))
    // Half rows, so the smallest bar on the range still shows as something.
    const halves = Math.max(1, Math.round((wanted / peak) * BAR_ROWS * HALF_STEPS))
    const filled = Math.max(0, Math.min(HALF_STEPS, halves - (row - 1) * HALF_STEPS))
    const glyph = blocks[filled] ?? ""
    if (glyph === "") return fg(MUTED_COLOR)(" ".repeat(columns))
    // One column of gap keeps neighbouring bars apart.
    return fg(direction === "UP" ? UP_COLOR : DOWN_COLOR)(glyph.repeat(columns - 1).padEnd(columns))
  })
}

/** Day-of-month under each bar, dropped when the columns are too narrow. */
function axisLabels(points: PortfolioPoint[], columns: number): TextChunk[] {
  if (columns < 3) return []
  return points.map((point) => fg(MUTED_COLOR)(point.date.slice(-2).padEnd(columns)))
}

/** Bar width in columns, wide enough to read and narrow enough to fit. */
function barWidth(count: number, width: number): number {
  if (count <= 0) return 1
  return Math.max(2, Math.min(6, Math.floor(Math.max(width, 1) / count)))
}

function metric(label: string, value: string, valueColor = VALUE_COLOR): TextChunk[] {
  return [fg(MUTED_COLOR)(`${label.padEnd(11)} `), fg(valueColor)(value)]
}

function newline(): TextChunk {
  return fg(VALUE_COLOR)("\n")
}

function formatProfit(value: number | null, percent: number | null, currency: string): string {
  if (value === null) return "—"
  const signed = `${value >= 0 ? "+" : "-"}${formatMoney(Math.abs(value), currency)}`
  return percent === null ? signed : `${signed}  ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null) return "—"
  const amount = value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "TRY" ? `₺${amount}` : `${amount} ${currency}`
}
