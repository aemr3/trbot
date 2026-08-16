import {
  BoxRenderable,
  ScrollBarRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type MouseEvent,
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
import { ChartBitmapRenderable, chartBitmapSupport } from "./chart/bitmap-renderable.ts"
import { drawCandlesticks, drawVolumeBars } from "./chart/chart-draw.ts"
import { getCandleColumn, getScaledY } from "./chart/geometry.ts"
import { CHART_PALETTE, DOWN_COLOR, UP_COLOR } from "./chart/palette.ts"
import {
  bufferToBrailleLines,
  createPixelBuffer,
  drawGridLines,
  drawGuideLine,
} from "./chart/pixel-buffer.ts"
import { KittyPlaceholderImages } from "./chart/kitty-placeholder.ts"
import { getCandlePixelX, renderCandleBitmap, type CandleChartBitmap } from "./chart/raster.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const MUTED_COLOR = "#777777"
const AXIS_COLOR = "#777777"
const ACTIVE_BUTTON_BG = "#333333"
const PRICE_PADDING_RATIO = 0.02
const MIN_HEIGHT_WITH_VOLUME = 14
const MAX_VOLUME_HEIGHT = 8
// Braille cells hold a 2x4 dot grid; three dots per candle keeps a two-dot
// body plus a one-dot gap at maximum density. The kitty renderer reuses the
// same capacity so scrolling behaves identically in both modes.
const BRAILLE_X = 2
const BRAILLE_Y = 4
const CANDLE_SPACING_DOTS = 3
// Wheel zoom: dots-per-candle multiplier per wheel notch, and how few candles
// may remain visible at maximum zoom-in.
const ZOOM_STEP = 1.25
const MIN_VISIBLE_ZOOM_CANDLES = 3
const DOUBLE_CLICK_MS = 400
// Trackpad swipes drift across axes, so a wheel gesture stays locked to the
// axis it started on while events keep arriving within this window.
const WHEEL_AXIS_LOCK_MS = 200
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
  private readonly chartArea: BoxRenderable
  private readonly plotText: TextRenderable
  private readonly plotBitmap: ChartBitmapRenderable
  private readonly timeAxis: TextRenderable
  private readonly axis: TextRenderable
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
  // Braille dots one candle occupies; wheel zoom shrinks/grows it.
  private zoomDots: number = CANDLE_SPACING_DOTS
  // Previous left-click on the plot, for double-click detection.
  private lastPlotClick: { time: number; x: number; y: number } | null = null
  // Axis of the wheel gesture in progress; cross-axis events are drift.
  private wheelGesture: { horizontal: boolean; time: number } | null = null
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
  // Kitty graphics support is discovered asynchronously; re-render when the
  // terminal answers so the chart upgrades from braille to true pixels.
  private readonly handleCapabilities = () => this.renderBodyAfterNextFrame()
  // Created lazily when running inside tmux with kitty graphics passthrough.
  private placeholderImages: KittyPlaceholderImages | null = null

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

    this.chartArea = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
      onMouseScroll: (event) => this.handleWheel(event),
      // Double-click resets the zoom, anchored at the cursor.
      onMouseDown: (event) => {
        if (event.button !== 0) return
        const previous = this.lastPlotClick
        const now = Date.now()
        this.lastPlotClick = { time: now, x: event.x, y: event.y }
        const isDoubleClick = previous !== null
          && now - previous.time <= DOUBLE_CLICK_MS
          && Math.abs(event.x - previous.x) <= 1
          && Math.abs(event.y - previous.y) <= 1
        if (isDoubleClick) {
          this.lastPlotClick = null
          this.zoomTo(CANDLE_SPACING_DOTS, event.x)
        }
      },
    })
    const plotColumn = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
    })
    this.plotText = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      width: "100%",
      wrapMode: "none",
      onSizeChange: () => this.renderBodyAfterNextFrame(),
    })
    this.plotBitmap = new ChartBitmapRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      visible: false,
    })
    this.timeAxis = new TextRenderable(renderer, {
      content: "",
      height: 1,
      width: "100%",
      fg: AXIS_COLOR,
      wrapMode: "none",
    })
    this.axis = new TextRenderable(renderer, {
      content: "",
      width: 10,
      wrapMode: "none",
    })
    plotColumn.add(this.plotText)
    plotColumn.add(this.plotBitmap)
    plotColumn.add(this.timeAxis)
    this.chartArea.add(plotColumn)
    this.chartArea.add(this.axis)

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
      onMouseScroll: (event) => this.handleWheel(event),
    })
    this.horizontalScrollBar.scrollStep = 1

    this.root.add(this.summary)
    this.root.add(targetToolbar)
    this.root.add(rangeToolbar)
    this.root.add(intervalToolbar)
    this.root.add(this.chartArea)
    this.root.add(this.horizontalScrollBar)
    this.paintToolbar()
    this.renderer.on("capabilities", this.handleCapabilities)
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
    this.renderer.off("capabilities", this.handleCapabilities)
    this.placeholderImages?.clear()
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
    this.showPlotMessage("Loading candles…", MUTED_COLOR)

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
        this.showPlotMessage(`Failed to load candles: ${errorMessage(error)}`, DOWN_COLOR)
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
      this.showPlotMessage("No candles available for this range and timeframe.", MUTED_COLOR)
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
      candleCapacity(series.candles, this.chartArea.width, this.zoomDots),
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
    const width = this.chartArea.width
    const height = this.chartArea.height
    if (width <= 0 || height <= 0) {
      this.renderBodyAfterNextFrame()
      return
    }
    const clampedOffset = Math.min(this.scrollOffset, this.maxScrollOffset())
    if (clampedOffset !== this.scrollOffset) {
      this.scrollOffset = clampedOffset
      this.renderSummary()
    }
    const reserveScrollbarRow = this.maxScrollOffset() > 0
    const bitmapSupport = chartBitmapSupport(this.renderer)
    const view = bitmapSupport
      ? renderCandleChartBitmapView(
          candles, width, height, this.range, this.scrollOffset, reserveScrollbarRow, bitmapSupport.cellPixel,
          this.zoomDots)
      : renderCandleChart(candles, width, height, this.range, this.scrollOffset, reserveScrollbarRow, this.zoomDots)
    if (typeof view === "string") {
      this.showPlotMessage(view, MUTED_COLOR)
      this.syncScrollbar()
      return
    }

    if (this.axis.width !== view.axisWidth) this.axis.width = view.axisWidth
    this.axis.content = view.axis
    this.timeAxis.content = view.timeAxis
    if (view.kind === "bitmap" && bitmapSupport?.mode === "placeholder") {
      // Kitty payloads must go through the renderer's serialized write queue:
      // raw process.stdout writes race the render thread and corrupt escape
      // sequences mid-frame. writeOut is private in the typings but is the
      // channel OpenTUI uses for its own out-of-frame sequences.
      this.placeholderImages ??= new KittyPlaceholderImages((data) =>
        (this.renderer as unknown as { writeOut(data: string): void }).writeOut(data),
      )
      this.plotText.content = this.placeholderImages.render(view.bitmap, view.plotWidth, view.rows)
      this.plotText.visible = true
      if (this.plotBitmap.visible) {
        this.plotBitmap.visible = false
        this.plotBitmap.setBitmap(null)
      }
    } else if (view.kind === "bitmap") {
      this.plotBitmap.setBitmap(view.bitmap)
      this.plotBitmap.visible = true
      this.plotText.visible = false
    } else {
      this.plotText.content = view.plot
      this.plotText.fg = "#cccccc"
      this.plotText.visible = true
      if (this.plotBitmap.visible) {
        this.plotBitmap.visible = false
        this.plotBitmap.setBitmap(null)
      }
    }
    this.syncScrollbar()
  }

  private showPlotMessage(message: string, color: string): void {
    this.plotText.content = message
    this.plotText.fg = color
    this.plotText.visible = true
    this.plotBitmap.visible = false
    this.plotBitmap.setBitmap(null)
    this.axis.content = ""
    this.timeAxis.content = ""
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollOffset + delta)
  }

  /** TradingView-style wheel: vertical zooms around the cursor, horizontal pans. */
  private handleWheel(event: MouseEvent): void {
    const scroll = event.scroll
    if (!scroll) return
    event.stopPropagation()
    const horizontal = scroll.direction === "left" || scroll.direction === "right"
    const now = Date.now()
    const gesture = this.wheelGesture
    if (gesture && gesture.horizontal !== horizontal && now - gesture.time <= WHEEL_AXIS_LOCK_MS) return
    this.wheelGesture = { horizontal, time: now }
    if (horizontal) {
      this.scrollBy(scroll.direction === "left" ? scroll.delta : -scroll.delta)
    } else {
      this.zoomBy(scroll.direction === "up", scroll.delta, event.x)
    }
  }

  private zoomBy(zoomIn: boolean, steps: number, anchorX: number): void {
    this.zoomTo(this.zoomDots * ZOOM_STEP ** (zoomIn ? steps : -steps), anchorX)
  }

  /**
   * Sets how many braille dots one candle occupies, keeping the candle under
   * the cursor at the same screen position. Zooming in stops at a handful of
   * candles; zooming out stops once the whole history fits.
   */
  private zoomTo(dots: number, anchorX: number): void {
    const candles = this.series?.candles
    if (!candles || candles.length === 0 || this.chartArea.width <= 0) return
    const layout = chartWidthLayout(candles, this.chartArea.width, this.zoomDots)
    const plotDots = layout.plotWidth * BRAILLE_X
    const maxDots = plotDots / MIN_VISIBLE_ZOOM_CANDLES
    const minDots = Math.min(CANDLE_SPACING_DOTS, plotDots / candles.length)
    const next = Math.max(minDots, Math.min(dots, maxDots))
    if (next === this.zoomDots) return

    const newCapacity = Math.max(1, Math.floor(plotDots / next))
    const fraction = Math.max(0, Math.min((anchorX - this.chartArea.x) / layout.plotWidth, 1))
    const end = candles.length - Math.min(this.scrollOffset, this.maxScrollOffset())
    const anchorIndex = end - layout.capacity * (1 - fraction)
    this.zoomDots = next
    const newEnd = anchorIndex + newCapacity * (1 - fraction)
    this.scrollOffset = Math.max(0, Math.min(Math.round(candles.length - newEnd), candles.length - Math.min(candles.length, newCapacity)))
    this.renderSummary()
    this.renderBody()
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
    return Math.max(0, candles.length - candleCapacity(candles, this.chartArea.width, this.zoomDots))
  }

  private syncScrollbar(): void {
    const candles = this.series?.candles
    if (!candles || candles.length === 0) {
      this.horizontalScrollBar.scrollSize = 0
      this.horizontalScrollBar.viewportSize = 0
      return
    }
    const { plotWidth, capacity } = chartWidthLayout(candles, this.chartArea.width, this.zoomDots)
    const maxOffset = Math.max(0, candles.length - capacity)
    const viewport = Math.min(candles.length, capacity)
    const scrollbar = this.horizontalScrollBar
    scrollbar.width = plotWidth
    scrollbar.scrollSize = candles.length
    // OpenTUI's slider clamps an incoming thumb size against the scroll range
    // from before the update, so growing the viewport (zooming out) leaves a
    // stale sliver of a thumb. Dropping to a minimal viewport first maximizes
    // that range, letting the real viewport apply unclamped.
    if (scrollbar.slider.viewPortSize !== viewport) {
      scrollbar.viewportSize = viewport === 1 ? 2 : 1
      scrollbar.viewportSize = viewport
    }
    scrollbar.scrollPosition = maxOffset - Math.min(this.scrollOffset, maxOffset)
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

interface ChartLayout {
  priceLabelWidth: number
  axisWidth: number
  plotWidth: number
  capacity: number
}

interface ChartFrame {
  layout: ChartLayout
  visible: Candle[]
  plotRows: number
  volumeRows: number
  totalRows: number
  floor: number
  ceiling: number
  latest: Candle
  gridRows: number[]
}

interface ChartViewBase {
  axis: StyledText
  timeAxis: string
  axisWidth: number
  plotWidth: number
}

export interface BrailleChartView extends ChartViewBase {
  kind: "braille"
  plot: StyledText
}

export interface BitmapChartView extends ChartViewBase {
  kind: "bitmap"
  bitmap: CandleChartBitmap
  /** Terminal rows the bitmap covers (price pane plus volume pane). */
  rows: number
}

function computeChartFrame(
  candles: Candle[],
  width: number,
  height: number,
  scrollOffset: number,
  reserveScrollbarRow: boolean,
  dotsPerCandle: number,
): ChartFrame | string {
  const safeWidth = Math.floor(width)
  const safeHeight = Math.floor(height)
  if (safeWidth < 18 || safeHeight < 4) return "Chart needs more room."

  const layout = chartWidthLayout(candles, safeWidth, dotsPerCandle)
  const maxScrollOffset = Math.max(0, candles.length - layout.capacity)
  const safeScrollOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxScrollOffset))
  const totalRows = safeHeight - 1 - (reserveScrollbarRow ? 1 : 0)
  if (layout.plotWidth < 4 || totalRows < 3) return "Chart needs more room."

  const visible = selectVisibleCandles(candles, layout.capacity, safeScrollOffset)
  const hasVolume = visible.some((candle) => candle.volume !== null && candle.volume > 0)
  const volumeRows = hasVolume && totalRows >= MIN_HEIGHT_WITH_VOLUME
    ? Math.min(MAX_VOLUME_HEIGHT, Math.max(3, Math.floor(totalRows * 0.12)))
    : 0
  const plotRows = totalRows - volumeRows
  const high = Math.max(...visible.map((candle) => candle.high))
  const low = Math.min(...visible.map((candle) => candle.low))
  const padding = Math.max((high - low) * PRICE_PADDING_RATIO, Math.abs(high) * 0.0005, 0.01)
  const guideCount = plotRows >= 28 ? 7 : plotRows >= 20 ? 6 : plotRows >= 12 ? 5 : 4
  const gridRows = Array.from(
    { length: guideCount },
    (_, index) => Math.round((index * (plotRows - 1)) / (guideCount - 1)),
  )

  return {
    layout,
    visible,
    plotRows,
    volumeRows,
    totalRows,
    floor: low - padding,
    ceiling: high + padding,
    latest: visible.at(-1)!,
    gridRows,
  }
}

/** Price axis column: `┫`+close on the guide row, `┤`+price on grid rows. */
function renderPriceAxis(frame: ChartFrame, guideRow: number): StyledText {
  const { layout, plotRows, volumeRows, latest, floor, ceiling, gridRows } = frame
  const span = ceiling - floor
  const grid = new Set(gridRows)
  const latestColor = latest.close >= latest.open ? UP_COLOR : DOWN_COLOR
  const chunks: TextChunk[] = []

  for (let row = 0; row < plotRows; row++) {
    if (row > 0) chunks.push(fg(AXIS_COLOR)("\n"))
    const isGuide = row === guideRow
    const glyph = isGuide ? "┫" : grid.has(row) ? "┤" : "│"
    // Inverse of the price mapping at this row's center, so a tick names the
    // price a candle touching that row would be trading at.
    const rowPrice = ceiling - ((row + 0.5) / plotRows) * span
    const label = isGuide ? formatPrice(latest.close) : grid.has(row) ? formatPrice(rowPrice) : ""
    chunks.push(fg(isGuide ? latestColor : AXIS_COLOR)(`${glyph} ${label.padStart(layout.priceLabelWidth)}`))
  }
  for (let row = 0; row < volumeRows; row++) {
    chunks.push(fg(AXIS_COLOR)(`\n${row === volumeRows - 1 ? "┴" : "│"}`))
  }
  return new StyledText(chunks)
}

/** Renders the scrolled candle window as braille cells plus axis columns. */
export function renderCandleChart(
  candles: Candle[],
  width: number,
  height: number,
  range: CandleRange,
  scrollOffset = 0,
  reserveScrollbarRow = false,
  dotsPerCandle = CANDLE_SPACING_DOTS,
): BrailleChartView | string {
  const frame = computeChartFrame(candles, width, height, scrollOffset, reserveScrollbarRow, dotsPerCandle)
  if (typeof frame === "string") return frame
  const { layout, visible, plotRows, volumeRows, totalRows, floor, ceiling, latest, gridRows } = frame

  const buf = createPixelBuffer(layout.plotWidth * BRAILLE_X, totalRows * BRAILLE_Y)
  const priceBottom = plotRows * BRAILLE_Y - 1
  drawGridLines(buf, gridRows.map((row) => row * BRAILLE_Y + 2), CHART_PALETTE.gridColor)
  const guideY = getScaledY(latest.close, floor, ceiling, 0, priceBottom)
  const rising = latest.close >= latest.open
  drawGuideLine(buf, guideY, rising ? CHART_PALETTE.guideUp : CHART_PALETTE.guideDown)
  drawCandlesticks(buf, visible, 0, priceBottom, CHART_PALETTE, floor, ceiling)
  if (volumeRows > 0) {
    drawVolumeBars(buf, visible, plotRows * BRAILLE_Y, totalRows * BRAILLE_Y - 1, CHART_PALETTE)
  }

  const plotChunks: TextChunk[] = []
  bufferToBrailleLines(buf).forEach((line, row) => {
    if (row > 0) plotChunks.push(fg(AXIS_COLOR)("\n"))
    plotChunks.push(...line)
  })

  const guideRow = Math.max(0, Math.min(plotRows - 1, Math.floor(guideY / BRAILLE_Y)))
  const timeTicks = buildTimeTicks(visible, range, layout.plotWidth, (index) =>
    getCandleColumn(index, visible.length, layout.plotWidth))
  return {
    kind: "braille",
    plot: new StyledText(plotChunks),
    axis: renderPriceAxis(frame, guideRow),
    timeAxis: renderTimeAxis(timeTicks, layout.plotWidth),
    axisWidth: layout.axisWidth,
    plotWidth: layout.plotWidth,
  }
}

/** Renders the scrolled candle window as a true-pixel bitmap for kitty terminals. */
export function renderCandleChartBitmapView(
  candles: Candle[],
  width: number,
  height: number,
  range: CandleRange,
  scrollOffset: number,
  reserveScrollbarRow: boolean,
  cellPixel: { width: number; height: number },
  dotsPerCandle = CANDLE_SPACING_DOTS,
): BitmapChartView | string {
  const frame = computeChartFrame(candles, width, height, scrollOffset, reserveScrollbarRow, dotsPerCandle)
  if (typeof frame === "string") return frame
  const { layout, visible, plotRows, volumeRows, totalRows, floor, ceiling, latest, gridRows } = frame

  const pixelWidth = Math.max(1, Math.round(layout.plotWidth * cellPixel.width))
  const pricePixels = Math.max(1, Math.round(plotRows * cellPixel.height))
  const volumePixels = volumeRows > 0 ? Math.round(volumeRows * cellPixel.height) : 0
  const guideY = getScaledY(latest.close, floor, ceiling, 0, pricePixels - 1)
  const rising = latest.close >= latest.open

  const bitmap = renderCandleBitmap({
    candles: visible,
    pixelWidth,
    pixelHeight: pricePixels + volumePixels,
    volumePixelHeight: volumePixels,
    min: floor,
    max: ceiling,
    gridYs: gridRows.map((row) => (row + 0.5) * cellPixel.height),
    guideY,
    guideColor: rising ? CHART_PALETTE.guideUp : CHART_PALETTE.guideDown,
    palette: CHART_PALETTE,
  })

  const guideRow = Math.max(0, Math.min(plotRows - 1, Math.floor(guideY / cellPixel.height)))
  const timeTicks = buildTimeTicks(visible, range, layout.plotWidth, (index) =>
    Math.max(0, Math.min(layout.plotWidth - 1,
      Math.floor(getCandlePixelX(index, visible.length, pixelWidth) / cellPixel.width))))
  return {
    kind: "bitmap",
    bitmap,
    rows: totalRows,
    axis: renderPriceAxis(frame, guideRow),
    timeAxis: renderTimeAxis(timeTicks, layout.plotWidth),
    axisWidth: layout.axisWidth,
    plotWidth: layout.plotWidth,
  }
}

interface TimeTick {
  column: number
  label: string
}

function buildTimeTicks(
  candles: Candle[],
  range: CandleRange,
  plotWidth: number,
  columnOf: (index: number) => number,
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
      column: columnOf(candleIndex),
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

export function selectVisibleCandles(candles: Candle[], capacity: number, scrollOffset = 0): Candle[] {
  const safeCapacity = Math.max(1, Math.floor(capacity))
  const maxOffset = Math.max(0, candles.length - safeCapacity)
  const safeOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxOffset))
  const end = candles.length - safeOffset
  return candles.slice(Math.max(0, end - safeCapacity), end)
}

function chartWidthLayout(candles: Candle[], width: number, dotsPerCandle = CANDLE_SPACING_DOTS): ChartLayout {
  const priceLabelWidth = Math.max(
    8,
    formatPrice(Math.max(...candles.map((candle) => candle.high))).length,
    formatPrice(Math.min(...candles.map((candle) => candle.low))).length,
  )
  const axisWidth = priceLabelWidth + 2
  const plotWidth = Math.max(1, Math.floor(width) - axisWidth)
  return {
    priceLabelWidth,
    axisWidth,
    plotWidth,
    capacity: Math.max(1, Math.floor((plotWidth * BRAILLE_X) / dotsPerCandle)),
  }
}

function candleCapacity(candles: Candle[], width: number, dotsPerCandle = CANDLE_SPACING_DOTS): number {
  return chartWidthLayout(candles, width, dotsPerCandle).capacity
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
