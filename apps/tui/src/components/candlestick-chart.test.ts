import { expect, test } from "bun:test"
import { RGBA, StyledText } from "@opentui/core"
import { createMockMouse, createTestRenderer } from "@opentui/core/testing"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleSeries, type CandleSource } from "@trbot/market/candle.ts"
import {
  CandlestickChart,
  isChartMessage,
  renderCandleChart,
  renderCandleChartBitmapView,
  selectVisibleCandles,
  type BitmapChartView,
  type BrailleChartView,
} from "./candlestick-chart.ts"
import { CHART_INDICATOR_COLORS, indicatorLines } from "@trbot/market/indicator.ts"
import { CHART_PALETTE, SELECTION_COLOR } from "./chart/palette.ts"
import { keyEvent } from "../key-event.test-fixture.ts"

const candles: Candle[] = [
  { timestamp: 1000, open: 10, high: 13, low: 9, close: 12, volume: 10 },
  { timestamp: 2000, open: 12, high: 14, low: 11, close: 13, volume: 20 },
  { timestamp: 3000, open: 13, high: 15, low: 10, close: 11, volume: 30 },
  { timestamp: 4000, open: 11, high: 12, low: 8, close: 9, volume: 40 },
]

const braille = /[⠁-⣿]/
const UP = RGBA.fromHex("#70d7a1")
const DOWN = RGBA.fromHex("#ff6b6b")

// Grains the renderers are asked about: five minutes reads as a time, a day
// reads as a date.
const MIN_5_MS = 300_000
const DAY_MS = 86_400_000

function view(
  input: Candle[],
  width: number,
  height: number,
  grainMs: number = MIN_5_MS,
  scrollOffset = 0,
  reserveScrollbarRow = false,
): BrailleChartView {
  const result = renderCandleChart(input, width, height, grainMs, scrollOffset, reserveScrollbarRow)
  if (isChartMessage(result)) throw new Error(result)
  return result
}

function brailleView(result: BrailleChartView | string): BrailleChartView {
  if (isChartMessage(result)) throw new Error(result)
  return result
}

function bitmapView(result: BitmapChartView | string): BitmapChartView {
  if (isChartMessage(result)) throw new Error(result)
  return result
}

function toText(styled: StyledText): string {
  return styled.chunks.map((chunk) => chunk.text).join("")
}

/** Waits out the wheel-gesture axis lock so the next scroll starts a new gesture. */
function settleWheelAxis(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 220))
}

/** Axis row holding the close label, which is the only one in the candle color. */
function axisGuideRow(axis: StyledText, color: RGBA): number {
  let row = 0
  for (const chunk of axis.chunks) {
    if (chunk.text.trim().length > 0 && chunk.fg?.equals(color)) return row
    row += chunk.text.split("\n").length - 1
  }
  return -1
}

/** Bitmap rows carrying the given palette color within a column range. */
function bitmapRows(view: BitmapChartView, color: string, fromColumn: number, toColumn: number): number[] {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  const { width, height, pixels } = view.bitmap
  const rows: number[] = []
  for (let row = 0; row < height; row++) {
    for (let column = fromColumn; column <= toColumn; column++) {
      const index = (row * width + column) * 4
      const matches = pixels[index + 3]! > 180
        && Math.abs(pixels[index]! - red!) <= 8
        && Math.abs(pixels[index + 1]! - green!) <= 8
        && Math.abs(pixels[index + 2]! - blue!) <= 8
      if (matches) {
        rows.push(row)
        break
      }
    }
  }
  return rows
}

/** Bitmap columns carrying the given palette color anywhere down their height. */
function bitmapColumns(view: BitmapChartView, color: string): number[] {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  const { width, height, pixels } = view.bitmap
  const columns: number[] = []
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < height; row++) {
      const index = (row * width + column) * 4
      const matches = pixels[index + 3]! > 60
        && Math.abs(pixels[index]! - red!) <= 8
        && Math.abs(pixels[index + 1]! - green!) <= 8
        && Math.abs(pixels[index + 2]! - blue!) <= 8
      if (matches) {
        columns.push(column)
        break
      }
    }
  }
  return columns
}

/** Plot cells whose chunk carries the given color, as {row, column} pairs. */
function cellsWithColor(plot: StyledText, color: RGBA): Array<{ row: number; column: number }> {
  const cells: Array<{ row: number; column: number }> = []
  let row = 0
  let column = 0
  for (const chunk of plot.chunks) {
    for (const character of chunk.text) {
      if (character === "\n") {
        row++
        column = 0
        continue
      }
      if (braille.test(character) && chunk.fg?.equals(color)) cells.push({ row, column })
      column++
    }
  }
  return cells
}

test("selects newest raw candles and scrolls backward without aggregating them", () => {
  expect(selectVisibleCandles(candles, 2)).toEqual(candles.slice(2))
  expect(selectVisibleCandles(candles, 2, 1)).toEqual(candles.slice(1, 3))
  expect(selectVisibleCandles(candles, 2, 100)).toEqual(candles.slice(0, 2))
  expect(selectVisibleCandles(candles, 2)[0]).toBe(candles[2])
})

test("renders braille candles with axis columns and a time axis", () => {
  const chart = view(candles, 40, 10)
  expect(chart.kind).toBe("braille")
  expect(chart.plotWidth).toBe(30)
  expect(chart.axisWidth).toBe(10)

  const plotLines = toText(chart.plot).split("\n")
  expect(plotLines).toHaveLength(9) // height minus the time-axis row
  expect(toText(chart.plot)).toMatch(braille)

  const axisLines = toText(chart.axis).split("\n")
  expect(axisLines).toHaveLength(9)
  expect(toText(chart.axis)).toContain("9,0000") // the last close
  expect(toText(chart.axis)).not.toMatch(/[│┤┫┴]/) // prices only, no tick glyphs
  expect(chart.timeAxis).toContain(":") // intraday hour labels
})

test("colors rising and falling candle bodies with the palette", () => {
  const chart = view(candles, 40, 10)
  expect(cellsWithColor(chart.plot, UP).length).toBeGreaterThan(0)
  expect(cellsWithColor(chart.plot, DOWN).length).toBeGreaterThan(0)
})

test("fills the complete body between open and close", () => {
  const chart = view([
    { timestamp: 1000, open: 100, high: 110, low: 100, close: 110, volume: null },
  ], 30, 20)
  const bodyCells = cellsWithColor(chart.plot, UP)
  const bodyColumn = Math.max(...bodyCells.map((cell) => cell.column))
  const rows = bodyCells.filter((cell) => cell.column === bodyColumn).map((cell) => cell.row)

  // No gaps between open and close.
  expect(Math.max(...rows) - Math.min(...rows) + 1).toBe(rows.length)
})

test("caps how much of the price pane a single candle may cover", () => {
  const plotRows = 19 // height minus the time-axis row
  const chart = view([
    { timestamp: 1000, open: 100, high: 110, low: 100, close: 110, volume: null },
  ], 30, plotRows + 1)
  const rows = new Set(cellsWithColor(chart.plot, UP).map((cell) => cell.row))

  // The lone candle would otherwise autoscale to the full pane height.
  expect(rows.size).toBeLessThanOrEqual(Math.ceil(plotRows * 0.35) + 1)
  expect(rows.size).toBeGreaterThan(2)
})

test("aligns the current-price guide row with the drawn close edge", () => {
  for (const height of [12, 18, 24, 30]) {
    for (const close of [37.6, 38.24, 38.5, 38.93, 39.1]) {
      const chart = view([
        { timestamp: 1000, open: 38.0, high: 39.0, low: 37.5, close: 38.5, volume: null },
        { timestamp: 2000, open: 38.5, high: 39.2, low: 37.2, close: 38.1, volume: null },
        { timestamp: 3000, open: 38.1, high: Math.max(38.1, close) + 0.08, low: Math.min(38.1, close) - 0.08, close, volume: null },
      ], 44, height)
      const axisLines = toText(chart.axis).split("\n")
      const guideRow = axisGuideRow(chart.axis, close >= 38.1 ? UP : DOWN)
      expect(guideRow).toBeGreaterThanOrEqual(0)
      // The label beside the guide is the close it sits on.
      expect(axisLines[guideRow]).toContain(close.toLocaleString("tr-TR", { minimumFractionDigits: 2 }))

      // The last candle's body must touch the guide row.
      const bodyCells = [...cellsWithColor(chart.plot, UP), ...cellsWithColor(chart.plot, DOWN)]
      const lastColumn = Math.max(...bodyCells.map((cell) => cell.column))
      const rowsAtLastColumn = bodyCells.filter((cell) => cell.column === lastColumn).map((cell) => cell.row)
      expect(rowsAtLastColumn).toContain(guideRow)
    }
  }
})

test("marks the picked candle in both renderers", () => {
  const picked = candles[1]!

  // Braille: the marker runs down the picked candle's own column, under the
  // candle itself, so it shows in the empty rows above and below it.
  const marked = brailleView(renderCandleChart(candles, 40, 20, MIN_5_MS, 0, false, 3, picked.timestamp))
  const markerCells = cellsWithColor(marked.plot, RGBA.fromHex(SELECTION_COLOR))
  expect(markerCells.length).toBeGreaterThan(0)
  expect(new Set(markerCells.map((cell) => cell.column)).size).toBe(1)

  // Nothing is marked until something is picked.
  const plain = brailleView(renderCandleChart(candles, 40, 20, MIN_5_MS, 0, false, 3))
  expect(cellsWithColor(plain.plot, RGBA.fromHex(SELECTION_COLOR))).toHaveLength(0)

  // Kitty: the same column, drawn as pixels.
  const bitmap = bitmapView(renderCandleChartBitmapView(
    candles, 40, 20, MIN_5_MS, 0, false, { width: 8, height: 16 }, 3, picked.timestamp))
  const markedColumns = bitmapColumns(bitmap, SELECTION_COLOR)
  expect(markedColumns.length).toBeGreaterThan(0)
  expect(Math.max(...markedColumns) - Math.min(...markedColumns)).toBeLessThanOrEqual(1)

  const plainBitmap = bitmapView(renderCandleChartBitmapView(
    candles, 40, 20, MIN_5_MS, 0, false, { width: 8, height: 16 }, 3))
  expect(bitmapColumns(plainBitmap, SELECTION_COLOR)).toHaveLength(0)

  // A candle outside the visible window takes its marker with it.
  const offWindow = brailleView(renderCandleChart(candles.slice(2), 40, 20, MIN_5_MS, 0, false, 3, picked.timestamp))
  expect(cellsWithColor(offWindow.plot, RGBA.fromHex(SELECTION_COLOR))).toHaveLength(0)
})

test("draws indicator overlays in both renderers", () => {
  // Enough candles for a 20-period average to have warmed up.
  const trend: Candle[] = Array.from({ length: 60 }, (_, index) => ({
    timestamp: 1_700_000_000_000 + index * 300_000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10,
  }))
  const line = indicatorLines(trend, ["EMA_20"], MIN_5_MS)
  expect(line).toHaveLength(1)

  const braille = brailleView(renderCandleChart(trend, 60, 20, MIN_5_MS, 0, false, 3, null, line))
  const overlayCells = cellsWithColor(
    braille.plot,
    RGBA.fromHex(CHART_INDICATOR_COLORS.EMA_20),
  )
  expect(overlayCells.length).toBeGreaterThan(0)

  const bitmap = bitmapView(renderCandleChartBitmapView(
    trend, 60, 20, MIN_5_MS, 0, false, { width: 8, height: 16 }, 3, null, line))
  expect(bitmapColumns(bitmap, CHART_INDICATOR_COLORS.EMA_20).length).toBeGreaterThan(0)

  // Nothing is drawn for an indicator nobody switched on.
  const plain = brailleView(renderCandleChart(trend, 60, 20, MIN_5_MS, 0, false, 3))
  expect(cellsWithColor(plain.plot, RGBA.fromHex(CHART_INDICATOR_COLORS.EMA_20))).toHaveLength(0)

  // Scrolled back, the overlay follows its candles rather than starting over:
  // the window is a slice of a series measured across the whole history.
  const scrolled = brailleView(renderCandleChart(trend, 60, 20, MIN_5_MS, 20, false, 3, null, line))
  expect(cellsWithColor(scrolled.plot, RGBA.fromHex(CHART_INDICATOR_COLORS.EMA_20)).length)
    .toBeGreaterThan(0)
})

test("keeps the indicator toggles, and reports what they turn on", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const reported: string[][] = []
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles: [{ timestamp: 1_000_000, open: 40, high: 44, low: 39, close: 43, volume: 10 }],
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, {
    source,
    initialIndicators: ["EMA_50"],
    onIndicatorsChange: (indicators) => reported.push(indicators),
  })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "stock-1", symbol: "TUPRS", displayName: "TUPRS" })

  // The row starts from the saved set rather than from nothing.
  const frame = await setup.waitForFrame((value) => value.includes("EMA50"))
  expect(frame).toContain("VWAP")
  expect(chart.indicators).toEqual(["EMA_50"])

  chart.toggleIndicator("VWAP")
  expect(chart.indicators).toEqual(["EMA_50", "VWAP"])
  chart.toggleIndicator("EMA_50")
  expect(chart.indicators).toEqual(["VWAP"])
  // Every change is reported, so the screen can persist it.
  expect(reported).toEqual([["EMA_50", "VWAP"], ["VWAP"]])

  chart.destroy()
  setup.renderer.destroy()
})

test("aligns the price guide with the close edge of the last bitmap candle", () => {
  for (const close of [38.24, 38.5, 38.79, 38.93, 37.94, 37.62]) {
    const rising = close >= 38.1
    const chart = bitmapView(renderCandleChartBitmapView([
      { timestamp: 1000, open: 38.0, high: 39.2, low: 37.5, close: 38.5, volume: null },
      { timestamp: 2000, open: 38.5, high: 39.2, low: 37.2, close: 38.1, volume: null },
      { timestamp: 3000, open: 38.1, high: Math.max(38.1, close) + 0.05, low: Math.min(38.1, close) - 0.05, close, volume: null },
    ], 60, 24, MIN_5_MS, 0, false, { width: 8, height: 16 }))

    // The guide spans the full width; only the last candle reaches the right edge.
    const guideRows = bitmapRows(chart, rising ? CHART_PALETTE.guideUp : CHART_PALETTE.guideDown, 0, 4)
    const bodyRows = bitmapRows(
      chart,
      rising ? CHART_PALETTE.candleUp : CHART_PALETTE.candleDown,
      chart.bitmap.width - 6,
      chart.bitmap.width - 1,
    )
    const closeEdge = rising ? Math.min(...bodyRows) : Math.max(...bodyRows) + 1

    // The guide straddles the pixel boundary its price maps to, and that
    // boundary is the body edge holding the close.
    expect(guideRows).toEqual([closeEdge - 1, closeEdge])
  }
})

test("anchors an under-filled window to the right at a capped candle size", () => {
  const chart = view(candles, 40, 10)
  const bodyCells = [...cellsWithColor(chart.plot, UP), ...cellsWithColor(chart.plot, DOWN)]
  const columns = bodyCells.map((cell) => cell.column)

  // Four candles keep their spacing instead of stretching over all 30 columns.
  expect(Math.min(...columns)).toBeGreaterThan(8)
  expect(Math.max(...columns)).toBeGreaterThan(chart.plotWidth - 4)
})

test("caps dense histories at the braille candle capacity", () => {
  const denseCandles: Candle[] = Array.from({ length: 24 }, (_, index) => ({
    timestamp: index * 1000,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1,
  }))
  const chart = view(denseCandles, 40, 10, DAY_MS)
  const bodyCells = cellsWithColor(chart.plot, UP)
  const columns = new Set(bodyCells.map((cell) => cell.column))

  // plotWidth 30 holds 15 candles at max density; bodies cover most columns.
  expect(columns.size).toBeGreaterThanOrEqual(20)
  expect(Math.max(...columns)).toBeGreaterThanOrEqual(28)
})

test("adds volume bars and intraday timestamps when space allows", () => {
  const sessionStart = new Date("2026-08-07T06:55:00Z").getTime()
  const sessionCandles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
    timestamp: sessionStart + index * 10 * 60 * 1000,
    open: 200 + index,
    high: 202 + index,
    low: 199 + index,
    close: 201 + index,
    volume: (index + 1) * 100,
  }))

  const chart = view(sessionCandles, 100, 20)
  const plotLines = toText(chart.plot).split("\n")
  expect(plotLines).toHaveLength(19)
  // Bottom three rows hold the volume pane, which carries no price labels.
  expect(plotLines.slice(-3).join("")).toMatch(braille)
  const volumeCells = cellsWithColor(chart.plot, RGBA.fromHex("#365747"))
  expect(volumeCells.some((cell) => cell.row >= 16)).toBe(true)
  const axisLines = toText(chart.axis).split("\n")
  expect(axisLines).toHaveLength(19)
  expect(axisLines.slice(-3).join("").trim()).toBe("")
  expect(chart.timeAxis).toContain("09:55")
  expect(chart.timeAxis).toContain("16:25")
})

test("labels a candle by the grain it covers, not by the range it sits in", () => {
  const firstDay = new Date("2026-07-31T07:00:00Z").getTime()
  const bars = (count: number, stepMs: number): Candle[] =>
    Array.from({ length: count }, (_, index) => ({
      timestamp: firstDay + index * stepMs,
      open: 150 + index,
      high: 152 + index,
      low: 149 + index,
      close: 151 + index,
      volume: 100 + index,
    }))

  // Daily candles over a week: the day is all that distinguishes them, in
  // English rather than the locale the prices are formatted in.
  const daily = view(bars(8, DAY_MS), 100, 20, DAY_MS)
  expect(daily.timeAxis).toMatch(/\d{2} Aug/)
  expect(daily.timeAxis).not.toContain(":")

  // Four-hour candles over the same week: without the hour, six of them a day
  // would carry the same label.
  const hourly = view(bars(40, 4 * 60 * 60 * 1000), 100, 20, 4 * 60 * 60 * 1000)
  expect(hourly.timeAxis).toMatch(/\d{2} \w{3} \d{2}:\d{2}/)
})

test("adds years to calendar labels only when the visible window crosses a year", () => {
  const firstDay = new Date("2025-06-17T07:00:00Z").getTime()
  const multiYearCandles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
    timestamp: firstDay + Math.round((index * 18 * 30 * 24 * 60 * 60 * 1000) / 39),
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = view(multiYearCandles, 100, 20, DAY_MS)
  expect(chart.timeAxis).toContain("17 Jun 25")
  expect(chart.timeAxis).toMatch(/\d{2} [A-Za-z]{3} 26/)
})

test("keeps a blank row above the native scrollbar when history scrolls", () => {
  const firstDay = new Date("2026-07-31T07:00:00Z").getTime()
  const history: Candle[] = Array.from({ length: 100 }, (_, index) => ({
    timestamp: firstDay + index * 24 * 60 * 60 * 1000,
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = view(history, 80, 20, DAY_MS, 0, true)
  const plotLines = toText(chart.plot).split("\n")
  expect(plotLines).toHaveLength(18) // one row ceded to the reserved scrollbar row
  expect(chart.timeAxis).toMatch(/\d{2} [A-ZÇĞİÖŞÜa-zçğıöşü]{3}/u)
})

test("rasterizes a true-pixel bitmap for kitty terminals", () => {
  const chart = bitmapView(renderCandleChartBitmapView(candles, 40, 10, MIN_5_MS, 0, false, { width: 8, height: 16 }))
  expect(chart.kind).toBe("bitmap")
  expect(chart.bitmap.width).toBe(30 * 8)
  expect(chart.bitmap.height).toBe(9 * 16)

  let hasUp = false
  let hasDown = false
  const pixels = chart.bitmap.pixels
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] === 0x70 && pixels[index + 1] === 0xd7 && pixels[index + 2] === 0xa1) hasUp = true
    if (pixels[index] === 0xff && pixels[index + 1] === 0x6b && pixels[index + 2] === 0x6b) hasDown = true
  }
  expect(hasUp).toBe(true)
  expect(hasDown).toBe(true)
  expect(axisGuideRow(chart.axis, DOWN)).toBeGreaterThanOrEqual(0) // the close label
  expect(chart.timeAxis).toContain(":")
})

test("pins the OHLC line to a clicked candle until it is cleared", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles: [
          { timestamp: 1_000_000, open: 40, high: 44, low: 39, close: 43, volume: 10 },
          { timestamp: 1_300_000, open: 43, high: 47, low: 42, close: 46, volume: 20 },
        ],
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "stock-1", symbol: "TUPRS", displayName: "TUPRS" })
  await setup.waitForFrame((value) => value.includes("O 43,00"))
  const mouse = createMockMouse(setup.renderer)

  // The two candles sit at the right of the plot, so a click at the left edge
  // lands on the older one.
  await mouse.click(0, 8)
  const pinned = await setup.waitForFrame((value) => value.includes("O 40,00"))
  expect(pinned).toContain("◆")
  expect(pinned).toContain("C 43,00")
  // The pinned candle names its date and, on a five-minute grain, its hour.
  expect(pinned).toMatch(/◆ \d{2} \w{3} \d{2}:\d{2}/)

  // Esc hands the line back to the market, and only then does it fall through.
  expect(chart.handleKey(keyEvent("escape"))).toBeTrue()
  const live = await setup.waitForFrame((value) => value.includes("O 43,00"))
  expect(live).not.toContain("◆")
  expect(chart.handleKey(keyEvent("escape"))).toBeFalse()

  chart.destroy()
  setup.renderer.destroy()
})

test("applies a live tick that arrives while candle history is loading", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16 })
  interface DeferredSeries {
    resolve?: (series: CandleSeries) => void
  }
  const deferred: DeferredSeries = {}
  const source: CandleSource = {
    loadCandles() {
      return new Promise((resolve) => {
        deferred.resolve = resolve
      })
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })
  chart.updateLastPrice("future-1", 110, 1_300_000)
  deferred.resolve?.({
    instrumentUid: "stock-1",
    range: "INTRADAY",
    interval: "MIN_5",
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    intervalMs: 600_000,
    currency: "TRY",
    candles: [{ timestamp: 1_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10 }],
  })

  const frame = await setup.waitForFrame((value) => value.includes("110,00"))
  expect(frame).toContain("5m · O 100,00")
  expect(frame).toContain("H 110,00")
  expect(frame).toContain("L 99,00")
  expect(frame).toContain("C 110,00")
  expect(frame).toContain("+10.00%")

  chart.destroy()
  setup.renderer.destroy()
})

test("carries what one contract costs beside the OHLC line", async () => {
  const setup = await createTestRenderer({ width: 100, height: 16 })
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 600_000,
        currency: "TRY",
        candles: [{ timestamp: 1_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10 }],
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })
  chart.setContractCost({ notional: 28_245, required: 5_213.32, currency: "TRY" })

  const frame = await setup.waitForFrame((value) => value.includes("1 lot ₺28.245,00"))
  expect(frame).toContain("margin ₺5.213,32")

  // Moving to a contract whose cost is not known yet drops the old one rather
  // than leaving the previous contract's numbers under a new symbol.
  chart.setContractCost(null)
  const cleared = await setup.waitForFrame((value) => !value.includes("1 lot"))
  expect(cleared).toContain("C 101,00")

  chart.destroy()
  setup.renderer.destroy()
})

test("updates OHLC from the current candle for the selected timeframe", async () => {
  const setup = await createTestRenderer({ width: 80, height: 18 })
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      const current = interval === "MIN_5"
        ? { timestamp: 2000, open: 12, high: 14, low: 8, close: 9, volume: 20 }
        : { timestamp: 2000, open: 22, high: 25, low: 20, close: 24, volume: 40 }
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: interval === "MIN_5" ? 300_000 : 600_000,
        currency: "TRY",
        candles: [{ timestamp: 1000, open: 10, high: 11, low: 9, close: 11, volume: 10 }, current],
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })

  await setup.waitForFrame((value) => value.includes("5m · O 12,00") && value.includes("-25.00%"))
  chart.handleKey(keyEvent("down"))
  const frame = await setup.waitForFrame((value) => value.includes("10m · O 22,00"))
  expect(frame).toContain("H 25,00")
  expect(frame).toContain("L 20,00")
  expect(frame).toContain("C 24,00")
  expect(frame).toContain("+9.09%")

  chart.destroy()
  setup.renderer.destroy()
})

test("wheel zooms around the cursor and horizontal scroll pans", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  const manyCandles: Candle[] = Array.from({ length: 200 }, (_, index) => ({
    timestamp: 1000 + index * 1000,
    open: 10,
    high: 13,
    low: 9,
    close: 12,
    volume: 10,
  }))
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles: manyCandles,
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "stock-1", symbol: "TUPRS", displayName: "TUPRS" })
  await setup.waitForFrame((value) => value.includes("O 10,00"))
  await setup.renderOnce()

  const mouse = createMockMouse(setup.renderer)
  const initialViewport = chart.viewport.viewportSize
  expect(initialViewport).toBeGreaterThan(0)

  // Wheel up at the right edge of the plot zooms in while the newest candle
  // stays anchored; wheel down zooms back out.
  await mouse.scroll(69, 10, "up")
  const zoomedViewport = chart.viewport.viewportSize
  expect(zoomedViewport).toBeLessThan(initialViewport)
  expect(chart.viewport.scrollOffset).toBe(0)
  await mouse.scroll(69, 10, "down")
  expect(chart.viewport.viewportSize).toBeGreaterThan(zoomedViewport)

  // Wheel up at the left edge anchors the oldest visible candle instead, so
  // the window slides back in history.
  await mouse.scroll(0, 10, "up")
  expect(chart.viewport.scrollOffset).toBeGreaterThan(0)

  // Trackpad-style horizontal scroll pans, over the plot and scrollbar alike.
  await settleWheelAxis()
  const beforePan = chart.viewport.scrollOffset
  await mouse.scroll(30, 10, "left")
  const panned = chart.viewport.scrollOffset
  expect(panned).toBeGreaterThan(beforePan)
  await mouse.scroll(chart.viewport.x + 10, chart.viewport.y, "right")
  expect(chart.viewport.scrollOffset).toBeLessThan(panned)

  // Vertical drift right after a horizontal swipe must not zoom.
  const viewportBeforeDrift = chart.viewport.viewportSize
  await mouse.scroll(30, 10, "up")
  expect(chart.viewport.viewportSize).toBe(viewportBeforeDrift)

  // Zooming out stops once the whole history fits in the viewport.
  await settleWheelAxis()
  for (let i = 0; i < 40; i++) await mouse.scroll(30, 10, "down")
  expect(chart.viewport.viewportSize).toBe(200)
  expect(chart.viewport.scrollOffset).toBe(0)

  // Zooming back in from the fully-out state must not leave the slider thumb
  // clamped to a stale sliver (OpenTUI clamps against the pre-update range).
  await mouse.scroll(30, 10, "up")
  expect(chart.viewport.sliderViewportSize).toBe(chart.viewport.viewportSize)

  // Double-clicking the plot resets the zoom to the default candle width.
  for (let i = 0; i < 10; i++) await mouse.scroll(30, 10, "up")
  expect(chart.viewport.viewportSize).toBeLessThan(initialViewport)
  await mouse.doubleClick(30, 10)
  expect(chart.viewport.viewportSize).toBe(initialViewport)
  expect(chart.viewport.sliderViewportSize).toBe(initialViewport)

  chart.destroy()
  setup.renderer.destroy()
})

test("shows independent range and timeframe controls", async () => {
  const setup = await createTestRenderer({ width: 80, height: 18 })
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles,
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })

  const frame = await setup.waitForFrame((value) => value.includes("Range") && value.includes("TF"))
  expect(frame).toContain("5Y")
  expect(frame).toContain("5m")

  chart.destroy()
  setup.renderer.destroy()
})

test("starts with saved chart choices and reports subsequent changes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 18 })
  const requested: Array<{ range: string; interval: string; target: string | undefined }> = []
  const selected: Array<{ range: string; interval: string }> = []
  const targets: string[] = []
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval, options) {
      requested.push({ range, interval, target: options?.target })
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles,
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, {
    source,
    initialRange: "WEEK",
    initialInterval: "MIN_15",
    initialTarget: "INSTRUMENT",
    onSelectionChange: (range, interval) => selected.push({ range, interval }),
    onTargetChange: (target) => targets.push(target),
  })
  // The asset row is mounted by the owner, next to the panel title.
  setup.renderer.root.add(chart.targetToolbar)
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })

  await setup.waitForFrame((frame) => frame.includes("15m · O"))
  expect(requested[0]).toEqual({ range: "WEEK", interval: "MIN_15", target: "INSTRUMENT" })
  const targetFrame = setup.captureCharFrame()
  expect(targetFrame).toContain("Stock")
  expect(targetFrame).toContain("Futures")
  expect(targetFrame).toContain("XU100")
  expect(targetFrame).toContain("XU030")

  chart.handleKey(keyEvent("down"))
  await setup.waitForFrame((frame) => frame.includes("30m · O"))
  expect(selected.at(-1)).toEqual({ range: "WEEK", interval: "MIN_30" })

  chart.handleKey(keyEvent("f"))
  await setup.waitForFrame(() => requested.length === 3)
  expect(requested.at(-1)?.target).toBe("BIST_100")
  expect(targets).toEqual(["BIST_100"])

  chart.handleKey(keyEvent("f"))
  await setup.waitForFrame(() => requested.length === 4)
  expect(requested.at(-1)?.target).toBe("BIST_30")

  chart.handleKey(keyEvent("f"))
  await setup.waitForFrame(() => requested.length === 5)
  expect(requested.at(-1)?.target).toBe("UNDERLYING")
  expect(targets).toEqual(["BIST_100", "BIST_30", "UNDERLYING"])

  // F walks the same ring the other way, whichever form the terminal reports.
  chart.handleKey(keyEvent("f", { shift: true }))
  await setup.waitForFrame(() => requested.length === 6)
  expect(requested.at(-1)?.target).toBe("BIST_30")

  chart.handleKey(keyEvent("f", { sequence: "F" }))
  await setup.waitForFrame(() => requested.length === 7)
  expect(requested.at(-1)?.target).toBe("BIST_100")
  expect(targets).toEqual(["BIST_100", "BIST_30", "UNDERLYING", "BIST_30", "BIST_100"])

  chart.destroy()
  setup.renderer.destroy()
})

test("scrolls through raw candle windows and jumps back to the newest candles", async () => {
  const setup = await createTestRenderer({ width: 80, height: 18 })
  const sessionStart = new Date("2026-08-07T06:55:00Z").getTime()
  let requestCount = 0
  const history: Candle[] = Array.from({ length: 100 }, (_, index) => ({
    timestamp: sessionStart + index * 5 * 60 * 1000,
    open: 200 + index / 10,
    high: 200.2 + index / 10,
    low: 199.8 + index / 10,
    close: 200.1 + index / 10,
    volume: null,
  }))
  const source: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      requestCount++
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles: history,
      }
    },
  }
  const chart = new CandlestickChart(setup.renderer, { source })
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TKFN0826", displayName: "TKFEN" })

  // Width 80 leaves a 70-column plot: 46 candles per window, newest last.
  const newestFrame = await setup.waitForFrame(
    (frame) => frame.includes("14:25") && frame.includes("◀") && frame.includes("▶") && !frame.includes("history"),
  )
  expect(newestFrame).toContain("█")
  expect(newestFrame).toMatch(braille)
  await setup.mockMouse.click(0, 17)
  await setup.waitForFrame((frame) => frame.includes("history"))
  expect(requestCount).toBe(1)

  chart.handleKey(keyEvent("home", { shift: true }))
  await setup.waitForFrame((frame) => frame.includes("09:55") && frame.includes("history · 5m · O 204,50"))

  chart.handleKey(keyEvent("end", { shift: true }))
  await setup.waitForFrame((frame) => frame.includes("14:25") && frame.includes("5m · O 209,90") && !frame.includes("history"))
  expect(requestCount).toBe(1)

  chart.destroy()
  setup.renderer.destroy()
})
