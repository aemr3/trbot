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
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_LABELS,
  CANDLE_RANGES,
  CANDLE_RANGE_LABELS,
  DEFAULT_INTERVAL_BY_RANGE,
  DEFAULT_INTERVALS_BY_RANGE,
  applyLivePrice,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "../market/candle.ts"

const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const MUTED_COLOR = "#777777"
const GRID_COLOR = "#303030"
const AXIS_COLOR = "#777777"
const ACTIVE_BUTTON_BG = "#333333"

export interface CandlestickChartOptions {
  source: CandleSource
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
  private readonly rangeButtons = new Map<CandleRange, BoxRenderable>()
  private readonly rangeButtonLabels = new Map<CandleRange, TextRenderable>()
  private readonly intervalButtons = new Map<CandleInterval, BoxRenderable>()
  private readonly intervalButtonLabels = new Map<CandleInterval, TextRenderable>()
  private instrument: ChartInstrument | null = null
  private series: CandleSeries | null = null
  private range: CandleRange = "INTRADAY"
  private interval: CandleInterval = "MIN_5"
  private availableIntervalsByRange: Record<CandleRange, CandleInterval[]> = { ...DEFAULT_INTERVALS_BY_RANGE }
  private pendingLivePrice: { instrumentUid: string; price: number; timestamp: number } | null = null
  private request: AbortController | null = null
  private focused = false
  private destroyed = false
  private bodyRenderScheduled = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: CandlestickChartOptions,
  ) {
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

    this.root.add(this.summary)
    this.root.add(rangeToolbar)
    this.root.add(intervalToolbar)
    this.root.add(this.body)
    this.paintToolbar()
  }

  setInstrument(instrument: ChartInstrument): void {
    if (this.destroyed) return
    const changed = this.instrument?.uid !== instrument.uid
    this.instrument = instrument
    if (!changed && this.series) return
    if (changed) this.pendingLivePrice = null
    this.load()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.paintToolbar()
  }

  handleKey(key: KeyEvent): boolean {
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
    if (applyLivePrice(this.series, price, timestamp)) this.renderSeries()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.request?.abort()
    this.request = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private selectRange(range: CandleRange): void {
    if (this.range === range) return
    this.range = range
    if (!this.availableIntervalsByRange[range].includes(this.interval)) {
      this.interval = DEFAULT_INTERVAL_BY_RANGE[range]
    }
    this.paintToolbar()
    if (this.instrument) this.load()
  }

  private selectInterval(interval: CandleInterval): void {
    if (!this.availableIntervalsByRange[this.range].includes(interval) || this.interval === interval) return
    this.interval = interval
    this.paintToolbar()
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
      .loadCandles(instrument.uid, this.range, this.interval, { signal: request.signal })
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
    const last = series.candles.at(-1)!
    const candleColor = last.close >= last.open ? UP_COLOR : DOWN_COLOR
    const candleChange = last.open === 0 ? 0 : (last.close / last.open - 1) * 100
    const changeText = `${candleChange >= 0 ? "+" : ""}${candleChange.toFixed(2)}%`

    this.summary.content = new StyledText([
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
    ])
  }

  private renderBody(): void {
    const candles = this.series?.candles
    if (!candles || candles.length === 0) return
    if (this.body.width <= 0 || this.body.height <= 0) {
      this.renderBodyAfterNextFrame()
      return
    }
    this.body.content = renderCandleChart(candles, this.body.width, this.body.height, this.range)
    this.body.fg = "#cccccc"
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
): StyledText | string {
  const safeWidth = Math.floor(width)
  const safeHeight = Math.floor(height)
  if (safeWidth < 18 || safeHeight < 4) return "Chart needs more room."

  const priceWidth = Math.max(8, formatPrice(Math.max(...candles.map((candle) => candle.high))).length + 1)
  const plotWidth = safeWidth - priceWidth
  const plotHeight = safeHeight - 1
  if (plotWidth < 4 || plotHeight < 3) return "Chart needs more room."

  const visible = aggregateCandles(candles, plotWidth)
  const high = Math.max(...visible.map((candle) => candle.high))
  const low = Math.min(...visible.map((candle) => candle.low))
  const padding = Math.max((high - low) * 0.04, Math.abs(high) * 0.0005, 0.01)
  const ceiling = high + padding
  const floor = low - padding
  const span = ceiling - floor
  const priceRow = (price: number) => Math.max(0, Math.min(plotHeight - 1, Math.round(((ceiling - price) / span) * (plotHeight - 1))))
  const chunks: TextChunk[] = []

  for (let row = 0; row < plotHeight; row++) {
    const gridLine = row === 0 || row === Math.floor((plotHeight - 1) / 2) || row === plotHeight - 1
    for (let column = 0; column < plotWidth; column++) {
      const candle = visible[column]
      if (!candle) {
        chunks.push(fg(GRID_COLOR)(gridLine ? "·" : " "))
        continue
      }
      const highRow = priceRow(candle.high)
      const lowRow = priceRow(candle.low)
      const openRow = priceRow(candle.open)
      const closeRow = priceRow(candle.close)
      const bodyTop = Math.min(openRow, closeRow)
      const bodyBottom = Math.max(openRow, closeRow)
      const color = candle.close >= candle.open ? UP_COLOR : DOWN_COLOR
      if (row >= bodyTop && row <= bodyBottom) {
        chunks.push(fg(color)(bodyTop === bodyBottom ? "━" : "█"))
      } else if (row >= highRow && row <= lowRow) {
        chunks.push(fg(color)("│"))
      } else {
        chunks.push(fg(GRID_COLOR)(gridLine ? "·" : " "))
      }
    }

    const labelPrice = ceiling - (row / Math.max(1, plotHeight - 1)) * span
    const label = gridLine ? formatPrice(labelPrice).padStart(priceWidth) : " ".repeat(priceWidth)
    chunks.push(fg(AXIS_COLOR)(label))
    if (row < plotHeight - 1) chunks.push(fg(AXIS_COLOR)("\n"))
  }

  chunks.push(fg(AXIS_COLOR)("\n"))
  const start = formatTimestamp(visible[0]?.timestamp, range)
  const end = formatTimestamp(visible.at(-1)?.timestamp, range)
  const gap = Math.max(1, plotWidth - start.length - end.length)
  chunks.push(fg(AXIS_COLOR)(`${start}${" ".repeat(gap)}${end}`.slice(0, plotWidth)))
  return new StyledText(chunks)
}

export function aggregateCandles(candles: Candle[], capacity: number): Candle[] {
  if (candles.length <= capacity) return candles
  const aggregated: Candle[] = []
  for (let bucket = 0; bucket < capacity; bucket++) {
    const start = Math.floor((bucket * candles.length) / capacity)
    const end = Math.floor(((bucket + 1) * candles.length) / capacity)
    const slice = candles.slice(start, Math.max(start + 1, end))
    const first = slice[0]!
    const last = slice.at(-1)!
    aggregated.push({
      timestamp: last.timestamp,
      open: first.open,
      high: Math.max(...slice.map((candle) => candle.high)),
      low: Math.min(...slice.map((candle) => candle.low)),
      close: last.close,
      volume: slice.every((candle) => candle.volume === null)
        ? null
        : slice.reduce((total, candle) => total + (candle.volume ?? 0), 0),
    })
  }
  return aggregated
}

function formatTimestamp(timestamp: number | undefined, range: CandleRange): string {
  if (timestamp === undefined) return ""
  const options: Intl.DateTimeFormatOptions =
    range === "INTRADAY"
      ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }
      : { day: "2-digit", month: "short", timeZone: "Europe/Istanbul" }
  return new Intl.DateTimeFormat("tr-TR", options).format(new Date(timestamp))
}

function formatPrice(price: number): string {
  const digits = Math.abs(price) >= 1000 ? 2 : Math.abs(price) >= 10 ? 2 : 4
  return price.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
