import {
  BoxRenderable,
  ScrollBarRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import {
  CANDLE_CHART_TARGETS,
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_LABELS,
  CANDLE_RANGES,
  CANDLE_RANGE_LABELS,
  DEFAULT_INTERVAL_BY_RANGE,
  DEFAULT_INTERVALS_BY_RANGE,
  applyLivePrice,
  type Candle,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "../market/candle.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const MUTED_COLOR = "#777777"
const GRID_COLOR = "#303030"
const AXIS_COLOR = "#777777"
const ACTIVE_BUTTON_BG = "#333333"
const UP_GUIDE_COLOR = "#365747"
const DOWN_GUIDE_COLOR = "#59383a"
const SPACED_CANDLE_SLOT_WIDTH = 2
const BODY_EDGE_MIN = 0.25
const BODY_EDGE_MAX = 0.75
const PRICE_PADDING_RATIO = 0.02
const MIN_HEIGHT_WITH_VOLUME = 14
const MAX_VOLUME_HEIGHT = 8
const CHART_TARGET_LABELS: Record<CandleChartTarget, string> = {
  UNDERLYING: "Stock",
  INSTRUMENT: "Futures",
  BIST_100: "XU100",
  BIST_30: "XU030",
}

export interface CandlestickChartOptions {
  source: CandleSource
  initialRange?: CandleRange
  initialInterval?: CandleInterval
  initialTarget?: CandleChartTarget
  onSelectionChange?: (range: CandleRange, interval: CandleInterval) => void
  onTargetChange?: (target: CandleChartTarget) => void
  onError?: (error: unknown) => void
  onFocusRequest?: () => void
}

interface ChartInstrument {
  uid: string
  symbol: string
  displayName: string
}

export class CandlestickChart {
  readonly root: BoxRenderable

  private readonly summary: TextRenderable
  private readonly body: TextRenderable
  private readonly horizontalScrollBar: ScrollBarRenderable
  private readonly rangeButtons = new Map<CandleRange, BoxRenderable>()
  private readonly rangeButtonLabels = new Map<CandleRange, TextRenderable>()
  private readonly intervalButtons = new Map<CandleInterval, BoxRenderable>()
  private readonly intervalButtonLabels = new Map<CandleInterval, TextRenderable>()
  private readonly targetButtons = new Map<CandleChartTarget, BoxRenderable>()
  private readonly targetButtonLabels = new Map<CandleChartTarget, TextRenderable>()
  private instrument: ChartInstrument | null = null
  private series: CandleSeries | null = null
  private range: CandleRange
  private interval: CandleInterval
  private target: CandleChartTarget
  private availableIntervalsByRange: Record<CandleRange, CandleInterval[]> = { ...DEFAULT_INTERVALS_BY_RANGE }
  private scrollOffset = 0
  private pendingLivePrice: { instrumentUid: string; price: number; timestamp: number } | null = null
  private request: AbortController | null = null
  private focused = false
  private destroyed = false
  private bodyRenderScheduled = false
  // Live ticks arrive in bursts at market open; rebuilding the whole plot per
  // tick freezes the app, so ticks mutate the series and renders are coalesced.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.destroyed) this.renderSeries()
  })

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: CandlestickChartOptions,
  ) {
    this.range = options.initialRange ?? "INTRADAY"
    this.target = options.initialTarget ?? "UNDERLYING"
    const initialInterval = options.initialInterval ?? DEFAULT_INTERVAL_BY_RANGE[this.range]
    this.interval = DEFAULT_INTERVALS_BY_RANGE[this.range].includes(initialInterval)
      ? initialInterval
      : DEFAULT_INTERVAL_BY_RANGE[this.range]

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
      width: "100%",
      minHeight: 5,
    })
    this.summary = new TextRenderable(renderer, {
      content: "Select an instrument to view its chart.",
      fg: MUTED_COLOR,
      wrapMode: "none",
      marginBottom: 1,
      onSizeChange: () => this.renderSummary(),
    })

    const targetToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      gap: 0,
      marginBottom: 1,
    })
    targetToolbar.add(new TextRenderable(renderer, { content: "Asset", fg: MUTED_COLOR, width: 6 }))
    for (const target of CANDLE_CHART_TARGETS) {
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
      const label = new TextRenderable(renderer, { content: CHART_TARGET_LABELS[target] })
      button.add(label)
      targetToolbar.add(button)
      this.targetButtons.set(target, button)
      this.targetButtonLabels.set(target, label)
    }

    const rangeToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      gap: 1,
      marginBottom: 1,
    })
    rangeToolbar.add(new TextRenderable(renderer, { content: "Range", fg: MUTED_COLOR, width: 6 }))
    for (const range of CANDLE_RANGES) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectRange(range)
        },
      })
      const label = new TextRenderable(renderer, { content: CANDLE_RANGE_LABELS[range] })
      button.add(label)
      rangeToolbar.add(button)
      this.rangeButtons.set(range, button)
      this.rangeButtonLabels.set(range, label)
    }

    const intervalToolbar = new BoxRenderable(renderer, {
      flexDirection: "row",
      height: 1,
      gap: 1,
      marginBottom: 1,
    })
    intervalToolbar.add(new TextRenderable(renderer, { content: "TF", fg: MUTED_COLOR, width: 6 }))
    for (const interval of CANDLE_INTERVALS) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectInterval(interval)
        },
      })
      const label = new TextRenderable(renderer, { content: CANDLE_INTERVAL_LABELS[interval] })
      button.add(label)
      intervalToolbar.add(button)
      this.intervalButtons.set(interval, button)
      this.intervalButtonLabels.set(interval, label)
    }

    this.body = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      width: "100%",
      wrapMode: "none",
      onSizeChange: () => this.renderBodyAfterNextFrame(),
    })
    this.horizontalScrollBar = new ScrollBarRenderable(renderer, {
      orientation: "horizontal",
      width: "100%",
      height: 1,
      showArrows: true,
      trackOptions: {
        foregroundColor: "#888888",
        backgroundColor: "#242424",
      },
      arrowOptions: {
        foregroundColor: "#888888",
        backgroundColor: "#181818",
      },
      onChange: (position) => {
        this.scrollTo(this.maxScrollOffset() - position)
      },
    })
    this.horizontalScrollBar.scrollStep = 1

    this.root.add(this.summary)
    this.root.add(targetToolbar)
    this.root.add(rangeToolbar)
    this.root.add(intervalToolbar)
    this.root.add(this.body)
    this.root.add(this.horizontalScrollBar)
    this.paintToolbar()
  }

  setInstrument(instrument: ChartInstrument): void {
    if (this.destroyed) return
    const changed = this.instrument?.uid !== instrument.uid
    this.instrument = instrument
    if (!changed && this.series) return
    if (changed) {
      this.pendingLivePrice = null
      this.scrollOffset = 0
    }
    this.load()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.paintToolbar()
  }

  handleKey(key: KeyEvent): boolean {
    if (!key.ctrl && !key.shift && !key.meta && !key.option && key.name === "f") {
      const current = CANDLE_CHART_TARGETS.indexOf(this.target)
      const target = CANDLE_CHART_TARGETS[(current + 1) % CANDLE_CHART_TARGETS.length]
      if (target) this.selectTarget(target)
      return true
    }
    if (key.shift && (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l")) {
      this.scrollBy(key.name === "left" || key.name === "h" ? 1 : -1)
      return true
    }
    if (key.shift && (key.name === "home" || key.name === "end")) {
      this.scrollTo(key.name === "home" ? this.maxScrollOffset() : 0)
      return true
    }
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l") {
      const direction = key.name === "left" || key.name === "h" ? -1 : 1
      const current = CANDLE_RANGES.indexOf(this.range)
      const next = (current + direction + CANDLE_RANGES.length) % CANDLE_RANGES.length
      const range = CANDLE_RANGES[next]
      if (range) this.selectRange(range)
      return true
    }
    if (key.name !== "up" && key.name !== "down" && key.name !== "k" && key.name !== "j") return false
    const availableIntervals = this.availableIntervalsByRange[this.range]
    const direction = key.name === "up" || key.name === "k" ? -1 : 1
    const current = availableIntervals.indexOf(this.interval)
    const start = current === -1 ? 0 : current
    const next = (start + direction + availableIntervals.length) % availableIntervals.length
    const interval = availableIntervals[next]
    if (interval) this.selectInterval(interval)
    return true
  }

  updateLastPrice(instrumentUid: string, price: number, timestamp: number): void {
    if (this.instrument?.uid !== instrumentUid || !Number.isFinite(price)) return
    if (!this.series) {
      this.pendingLivePrice = { instrumentUid, price, timestamp }
      return
    }
    const previousLength = this.series.candles.length
    if (applyLivePrice(this.series, price, timestamp)) {
      if (this.scrollOffset > 0) this.scrollOffset += this.series.candles.length - previousLength
      this.liveRender.schedule()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.liveRender.cancel()
    this.request?.abort()
    this.request = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private selectRange(range: CandleRange): void {
    if (this.range === range) return
    this.range = range
    this.scrollOffset = 0
    if (!this.availableIntervalsByRange[range].includes(this.interval)) {
      this.interval = DEFAULT_INTERVAL_BY_RANGE[range]
    }
    this.paintToolbar()
    this.options.onSelectionChange?.(this.range, this.interval)
    if (this.instrument) this.load()
  }

  private selectTarget(target: CandleChartTarget): void {
    if (this.target === target) return
    this.target = target
    this.pendingLivePrice = null
    this.scrollOffset = 0
    this.paintToolbar()
    this.options.onTargetChange?.(target)
    if (this.instrument) this.load()
  }

  private selectInterval(interval: CandleInterval): void {
    if (!this.availableIntervalsByRange[this.range].includes(interval) || this.interval === interval) return
    this.interval = interval
    this.scrollOffset = 0
    this.paintToolbar()
    this.options.onSelectionChange?.(this.range, this.interval)
    if (this.instrument) this.load()
  }

  private load(): void {
    const instrument = this.instrument
    if (!instrument) return
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    this.series = null
    this.summary.content = `${CANDLE_INTERVAL_LABELS[this.interval]} · Loading OHLC…`
    this.summary.fg = "#aaaaaa"
    this.body.content = "Loading candles…"
    this.body.fg = MUTED_COLOR

    void this.options.source
      .loadCandles(instrument.uid, this.range, this.interval, { signal: request.signal, target: this.target })
      .then((series) => {
        if (this.destroyed || request.signal.aborted || this.request !== request) return
        this.series = series
        this.range = series.range
        this.interval = series.interval
        this.availableIntervalsByRange = series.availableIntervalsByRange
        const pending = this.pendingLivePrice
        if (pending?.instrumentUid === instrument.uid) {
          applyLivePrice(series, pending.price, pending.timestamp)
          this.pendingLivePrice = null
        }
        this.paintToolbar()
        this.renderSeries()
      })
      .catch((error) => {
        if (this.destroyed || request.signal.aborted || this.request !== request) return
        this.summary.content = `${instrument.symbol} — ${instrument.displayName}`
        this.body.content = `Failed to load candles: ${errorMessage(error)}`
        this.body.fg = DOWN_COLOR
        this.options.onError?.(error)
      })
  }

  private renderSeries(): void {
    const instrument = this.instrument
    const candles = this.series?.candles ?? []
    if (!instrument) return
    if (candles.length === 0) {
      this.summary.content = `${instrument.symbol} — ${instrument.displayName}`
      this.summary.fg = "#aaaaaa"
      this.body.content = "No candles available for this range and timeframe."
      this.body.fg = MUTED_COLOR
      return
    }

    this.renderSummary()
    this.renderBody()
  }

  private renderSummary(): void {
    const series = this.series
    if (!series || series.candles.length === 0) return
    const visible = selectVisibleCandles(
      series.candles,
      candleCapacity(series.candles, this.body.width),
      this.scrollOffset,
    )
    const last = visible.at(-1) ?? series.candles.at(-1)!
    const candleColor = last.close >= last.open ? UP_COLOR : DOWN_COLOR
    const candleChange = last.open === 0 ? 0 : (last.close / last.open - 1) * 100
    const changeText = `${candleChange >= 0 ? "+" : ""}${candleChange.toFixed(2)}%`

    const chunks: TextChunk[] = []
    if (this.scrollOffset > 0 && this.maxScrollOffset() > 0) {
      chunks.push(fg(MUTED_COLOR)("history · "))
    }
    chunks.push(
      fg("#aaaaaa")(`${CANDLE_INTERVAL_LABELS[series.interval]} · `),
      fg(MUTED_COLOR)("O "),
      fg(candleColor)(formatPrice(last.open)),
      fg(MUTED_COLOR)("  H "),
      fg(candleColor)(formatPrice(last.high)),
      fg(MUTED_COLOR)("  L "),
      fg(candleColor)(formatPrice(last.low)),
      fg(MUTED_COLOR)("  C "),
      fg(candleColor)(formatPrice(last.close)),
      fg(candleColor)(`  ${changeText}`),
    )
    this.summary.content = new StyledText(chunks)
  }

  private renderBody(): void {
    const candles = this.series?.candles
    if (!candles || candles.length === 0) return
    if (this.body.width <= 0 || this.body.height <= 0) {
      this.renderBodyAfterNextFrame()
      return
    }
    const clampedOffset = Math.min(this.scrollOffset, this.maxScrollOffset())
    if (clampedOffset !== this.scrollOffset) {
      this.scrollOffset = clampedOffset
      this.renderSummary()
    }
    this.body.content = renderCandleChart(
      candles,
      this.body.width,
      this.body.height,
      this.range,
      this.scrollOffset,
      this.maxScrollOffset() > 0,
    )
    this.body.fg = "#cccccc"
    this.syncScrollbar()
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollOffset + delta)
  }

  private scrollTo(offset: number): void {
    const next = Math.max(0, Math.min(Math.floor(offset), this.maxScrollOffset()))
    if (next === this.scrollOffset) return
    this.scrollOffset = next
    this.renderSummary()
    this.renderBody()
  }

  private maxScrollOffset(): number {
    const candles = this.series?.candles
    if (!candles || candles.length === 0) return 0
    return Math.max(0, candles.length - candleCapacity(candles, this.body.width))
  }

  private syncScrollbar(): void {
    const candles = this.series?.candles
    if (!candles || candles.length === 0) {
      this.horizontalScrollBar.scrollSize = 0
      this.horizontalScrollBar.viewportSize = 0
      return
    }
    const { plotWidth, capacity } = chartWidthLayout(candles, this.body.width)
    const maxOffset = Math.max(0, candles.length - capacity)
    this.horizontalScrollBar.width = plotWidth
    this.horizontalScrollBar.scrollSize = candles.length
    this.horizontalScrollBar.viewportSize = Math.min(candles.length, capacity)
    this.horizontalScrollBar.scrollPosition = maxOffset - Math.min(this.scrollOffset, maxOffset)
  }

  private renderBodyAfterNextFrame(): void {
    if (this.bodyRenderScheduled || this.destroyed) return
    this.bodyRenderScheduled = true
    this.renderer.once("frame", () => {
      queueMicrotask(() => {
        this.bodyRenderScheduled = false
        if (!this.destroyed) this.renderBody()
      })
    })
  }

  private paintToolbar(): void {
    for (const target of CANDLE_CHART_TARGETS) {
      const selected = this.target === target
      const button = this.targetButtons.get(target)
      const label = this.targetButtonLabels.get(target)
      if (!button || !label) continue
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : undefined
      label.fg = selected ? "#ffffff" : this.focused ? "#aaaaaa" : "#666666"
    }
    for (const range of CANDLE_RANGES) {
      const selected = this.range === range
      const button = this.rangeButtons.get(range)
      const label = this.rangeButtonLabels.get(range)
      if (!button || !label) continue
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : undefined
      label.fg = selected ? "#ffffff" : this.focused ? "#aaaaaa" : "#666666"
    }
    const availableIntervals = this.availableIntervalsByRange[this.range]
    for (const interval of CANDLE_INTERVALS) {
      const available = availableIntervals.includes(interval)
      const selected = this.interval === interval
      const button = this.intervalButtons.get(interval)
      const label = this.intervalButtonLabels.get(interval)
      if (!button || !label) continue
      button.visible = available
      button.backgroundColor = selected ? ACTIVE_BUTTON_BG : undefined
      label.fg = selected ? "#ffffff" : this.focused ? "#aaaaaa" : "#666666"
    }
  }
}

export function renderCandleChart(
  candles: Candle[],
  width: number,
  height: number,
  range: CandleRange,
  scrollOffset = 0,
  reserveScrollbarRow = false,
): StyledText | string {
  const safeWidth = Math.floor(width)
  const safeHeight = Math.floor(height)
  if (safeWidth < 18 || safeHeight < 4) return "Chart needs more room."

  const { priceLabelWidth, axisWidth, plotWidth, candleSlotWidth, capacity } = chartWidthLayout(candles, safeWidth)
  const maxScrollOffset = Math.max(0, candles.length - capacity)
  const safeScrollOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxScrollOffset))
  const totalPlotHeight = safeHeight - 1 - (reserveScrollbarRow ? 1 : 0)
  if (plotWidth < 4 || totalPlotHeight < 3) return "Chart needs more room."

  const visible = selectVisibleCandles(candles, capacity, safeScrollOffset)
  const hasVolume = visible.some((candle) => candle.volume !== null && candle.volume > 0)
  const volumeHeight = hasVolume && totalPlotHeight >= MIN_HEIGHT_WITH_VOLUME
    ? Math.min(MAX_VOLUME_HEIGHT, Math.max(3, Math.floor(totalPlotHeight * 0.12)))
    : 0
  const plotHeight = totalPlotHeight - volumeHeight
  const high = Math.max(...visible.map((candle) => candle.high))
  const low = Math.min(...visible.map((candle) => candle.low))
  const padding = Math.max((high - low) * PRICE_PADDING_RATIO, Math.abs(high) * 0.0005, 0.01)
  const ceiling = high + padding
  const floor = low - padding
  const span = ceiling - floor
  const priceHeight = (price: number) => Math.max(0, Math.min(plotHeight, ((price - floor) / span) * plotHeight))
  const firstCandleColumn = Math.max(0, plotWidth - visible.length * candleSlotWidth)
  const latest = visible.at(-1)!
  const latestColor = latest.close >= latest.open ? UP_COLOR : DOWN_COLOR
  const guideColor = latest.close >= latest.open ? UP_GUIDE_COLOR : DOWN_GUIDE_COLOR
  // The guide follows the *drawn* candle rather than the abstract price:
  // `candleGlyph` suppresses close-edge slivers shorter than BODY_EDGE_MIN, so
  // the close edge can be rendered one row past the row that mathematically
  // holds the close. Mirroring that decision keeps the line, its ┫ tick, and
  // the label on a row the candle body touches — a line that is exact in price
  // but sits in the empty cell beside the candle reads as misaligned.
  const closeHeight = priceHeight(latest.close)
  const closeOffset = closeHeight - Math.floor(closeHeight)
  const closeEdgeCell = latest.close >= latest.open
    ? Math.floor(closeHeight) - (closeOffset > BODY_EDGE_MIN ? 0 : 1)
    : Math.floor(closeHeight) + (closeOffset < BODY_EDGE_MAX ? 0 : 1)
  const currentPriceRow = Math.max(0, Math.min(plotHeight - 1, plotHeight - closeEdgeCell))
  const horizontalGuideCount = plotHeight >= 28 ? 7 : plotHeight >= 20 ? 6 : plotHeight >= 12 ? 5 : 4
  const gridRows = new Set(
    Array.from({ length: horizontalGuideCount }, (_, index) =>
      Math.round((index * (plotHeight - 1)) / (horizontalGuideCount - 1))),
  )
  const timeTicks = buildTimeTicks(visible, range, firstCandleColumn, candleSlotWidth, plotWidth)
  const gridColumns = new Set(timeTicks.map((tick) => tick.column))
  const chunks: TextChunk[] = []

  for (let row = 0; row < plotHeight; row++) {
    const gridLine = gridRows.has(row)
    for (let column = 0; column < plotWidth; column++) {
      let candle: Candle | undefined
      if (column >= firstCandleColumn && (column - firstCandleColumn) % candleSlotWidth === 0) {
        candle = visible[(column - firstCandleColumn) / candleSlotWidth]
      }

      if (candle) {
        const glyph = candleGlyph(candle, row, plotHeight, priceHeight)
        if (glyph) {
          chunks.push(fg(candle.close >= candle.open ? UP_COLOR : DOWN_COLOR)(glyph))
          continue
        }
      }

      if (row === currentPriceRow) chunks.push(fg(guideColor)("─"))
      else if (gridLine) chunks.push(fg(GRID_COLOR)(gridColumns.has(column) ? "┼" : "┄"))
      else chunks.push(fg(GRID_COLOR)(gridColumns.has(column) ? "┊" : " "))
    }

    const isCurrentPrice = row === currentPriceRow
    const axisColor = isCurrentPrice ? latestColor : AXIS_COLOR
    const axisGlyph = isCurrentPrice ? "┫" : gridLine ? "┤" : "│"
    // Inverse of `priceHeight` at this row's own level, so a tick names the
    // price a candle touching that row would be trading at.
    const rowPrice = ceiling - (row / plotHeight) * span
    const label = isCurrentPrice
      ? formatPrice(latest.close).padStart(priceLabelWidth)
      : gridLine
        ? formatPrice(rowPrice).padStart(priceLabelWidth)
        : " ".repeat(priceLabelWidth)
    chunks.push(fg(axisColor)(`${axisGlyph} ${label}`))
    chunks.push(fg(AXIS_COLOR)("\n"))
  }

  if (volumeHeight > 0) {
    renderVolumePane(chunks, visible, volumeHeight, plotWidth, axisWidth, firstCandleColumn, candleSlotWidth, gridColumns)
  }

  chunks.push(fg(AXIS_COLOR)(renderTimeAxis(timeTicks, plotWidth)))
  if (reserveScrollbarRow) chunks.push(fg(AXIS_COLOR)(`\n${" ".repeat(safeWidth)}`))
  return new StyledText(chunks)
}

function candleGlyph(
  candle: Candle,
  row: number,
  plotHeight: number,
  priceHeight: (price: number) => number,
): string | null {
  const y = plotHeight - row
  const high = priceHeight(candle.high)
  const low = priceHeight(candle.low)
  const bodyHigh = priceHeight(Math.max(candle.open, candle.close))
  const bodyLow = priceHeight(Math.min(candle.open, candle.close))

  if (Math.ceil(high) >= y && y >= Math.floor(bodyHigh)) {
    const bodyDistance = bodyHigh - y
    const wickDistance = high - y
    if (bodyDistance > BODY_EDGE_MAX) return "┃"
    if (bodyDistance > BODY_EDGE_MIN) return wickDistance > BODY_EDGE_MAX ? "╽" : "╻"
    if (wickDistance > BODY_EDGE_MAX) return "│"
    if (wickDistance > BODY_EDGE_MIN) return "╷"
    return null
  }

  if (Math.ceil(bodyLow) >= y && y >= Math.floor(low)) {
    const bodyDistance = bodyLow - y
    const wickDistance = low - y
    if (bodyDistance < BODY_EDGE_MIN) return "┃"
    if (bodyDistance < BODY_EDGE_MAX) return wickDistance < BODY_EDGE_MIN ? "╿" : "╹"
    if (wickDistance < BODY_EDGE_MIN) return "│"
    if (wickDistance < BODY_EDGE_MAX) return "╵"
  }

  if (bodyHigh >= y && y >= Math.ceil(bodyLow)) return "┃"

  return null
}

interface TimeTick {
  column: number
  label: string
}

function buildTimeTicks(
  candles: Candle[],
  range: CandleRange,
  firstCandleColumn: number,
  candleSlotWidth: number,
  plotWidth: number,
): TimeTick[] {
  const desiredCount = plotWidth >= 60 ? 5 : plotWidth >= 30 ? 3 : 2
  const count = Math.min(desiredCount, candles.length)
  if (count === 0) return []
  const firstTimestamp = candles[0]?.timestamp
  const lastTimestamp = candles.at(-1)?.timestamp
  const includeYear = range !== "INTRADAY"
    && firstTimestamp !== undefined
    && lastTimestamp !== undefined
    && calendarYear(firstTimestamp) !== calendarYear(lastTimestamp)

  const ticks: TimeTick[] = []
  for (let tickIndex = 0; tickIndex < count; tickIndex++) {
    const candleIndex = count === 1
      ? 0
      : Math.round((tickIndex * (candles.length - 1)) / (count - 1))
    const candle = candles[candleIndex]
    if (!candle) continue
    ticks.push({
      column: Math.min(plotWidth - 1, firstCandleColumn + candleIndex * candleSlotWidth),
      label: formatTimestamp(candle.timestamp, range, includeYear),
    })
  }
  return ticks
}

function renderTimeAxis(ticks: TimeTick[], plotWidth: number): string {
  const cells = Array.from({ length: plotWidth }, () => " ")
  let previousEnd = -2
  for (const [index, tick] of ticks.entries()) {
    const isFirst = index === 0
    const isLast = index === ticks.length - 1
    const preferredStart = isFirst
      ? tick.column
      : isLast
        ? tick.column - tick.label.length + 1
        : tick.column - Math.floor(tick.label.length / 2)
    const start = Math.max(0, Math.min(plotWidth - tick.label.length, preferredStart))
    if (start <= previousEnd + 1) continue
    for (let character = 0; character < tick.label.length; character++) {
      cells[start + character] = tick.label[character] ?? " "
    }
    previousEnd = start + tick.label.length - 1
  }
  return cells.join("")
}

function renderVolumePane(
  chunks: TextChunk[],
  candles: Candle[],
  height: number,
  plotWidth: number,
  axisWidth: number,
  firstCandleColumn: number,
  candleSlotWidth: number,
  gridColumns: Set<number>,
): void {
  const maxVolume = Math.max(...candles.map((candle) => candle.volume ?? 0))
  for (let row = 0; row < height; row++) {
    const threshold = height - row - 1
    for (let column = 0; column < plotWidth; column++) {
      let candle: Candle | undefined
      if (column >= firstCandleColumn && (column - firstCandleColumn) % candleSlotWidth === 0) {
        candle = candles[(column - firstCandleColumn) / candleSlotWidth]
      }
      const scaledVolume = candle && maxVolume > 0 ? ((candle.volume ?? 0) / maxVolume) * height : 0
      if (candle && scaledVolume > threshold) {
        chunks.push(fg(candle.close >= candle.open ? UP_GUIDE_COLOR : DOWN_GUIDE_COLOR)("┃"))
      } else {
        chunks.push(fg(GRID_COLOR)(gridColumns.has(column) ? "┊" : " "))
      }
    }
    chunks.push(fg(AXIS_COLOR)(`${row === height - 1 ? "┴" : "│"}${" ".repeat(axisWidth - 1)}\n`))
  }
}

export function selectVisibleCandles(candles: Candle[], capacity: number, scrollOffset = 0): Candle[] {
  const safeCapacity = Math.max(1, Math.floor(capacity))
  const maxOffset = Math.max(0, candles.length - safeCapacity)
  const safeOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxOffset))
  const end = candles.length - safeOffset
  return candles.slice(Math.max(0, end - safeCapacity), end)
}

interface ChartWidthLayout {
  priceLabelWidth: number
  axisWidth: number
  plotWidth: number
  candleSlotWidth: number
  capacity: number
}

function chartWidthLayout(candles: Candle[], width: number): ChartWidthLayout {
  const priceLabelWidth = Math.max(
    8,
    formatPrice(Math.max(...candles.map((candle) => candle.high))).length,
    formatPrice(Math.min(...candles.map((candle) => candle.low))).length,
  )
  const axisWidth = priceLabelWidth + 2
  const plotWidth = Math.max(1, Math.floor(width) - axisWidth)
  const candleSlotWidth = candles.length <= Math.floor(plotWidth / 3) ? SPACED_CANDLE_SLOT_WIDTH : 1
  return {
    priceLabelWidth,
    axisWidth,
    plotWidth,
    candleSlotWidth,
    capacity: Math.max(1, Math.floor(plotWidth / candleSlotWidth)),
  }
}

function candleCapacity(candles: Candle[], width: number): number {
  return chartWidthLayout(candles, width).capacity
}

function formatTimestamp(timestamp: number | undefined, range: CandleRange, includeYear = false): string {
  if (timestamp === undefined) return ""
  const options: Intl.DateTimeFormatOptions =
    range === "INTRADAY"
      ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }
      : {
          day: "2-digit",
          month: "short",
          year: includeYear ? "2-digit" : undefined,
          timeZone: "Europe/Istanbul",
        }
  return new Intl.DateTimeFormat("tr-TR", options).format(new Date(timestamp))
}

function calendarYear(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Istanbul" }).format(new Date(timestamp))
}

function formatPrice(price: number): string {
  const digits = Math.abs(price) >= 1000 ? 2 : Math.abs(price) >= 10 ? 2 : 4
  return price.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
