import { expect, test } from "bun:test"
import { RGBA, StyledText, type KeyEvent } from "@opentui/core"
import { createMockMouse, createTestRenderer } from "@opentui/core/testing"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleRange, type CandleSeries, type CandleSource } from "../market/candle.ts"
import {
  CandlestickChart,
  renderCandleChart,
  renderCandleChartBitmapView,
  selectVisibleCandles,
  type BitmapChartView,
  type BrailleChartView,
} from "./candlestick-chart.ts"

const candles: Candle[] = [
  { timestamp: 1000, open: 10, high: 13, low: 9, close: 12, volume: 10 },
  { timestamp: 2000, open: 12, high: 14, low: 11, close: 13, volume: 20 },
  { timestamp: 3000, open: 13, high: 15, low: 10, close: 11, volume: 30 },
  { timestamp: 4000, open: 11, high: 12, low: 8, close: 9, volume: 40 },
]

const braille = /[⠁-⣿]/
const UP = RGBA.fromHex("#70d7a1")
const DOWN = RGBA.fromHex("#ff6b6b")

function view(
  input: Candle[],
  width: number,
  height: number,
  range: CandleRange = "INTRADAY",
  scrollOffset = 0,
  reserveScrollbarRow = false,
): BrailleChartView {
  const result = renderCandleChart(input, width, height, range, scrollOffset, reserveScrollbarRow)
  expect(typeof result).not.toBe("string")
  return result as BrailleChartView
}

function toText(styled: StyledText): string {
  return styled.chunks.map((chunk) => chunk.text).join("")
}

/** Waits out the wheel-gesture axis lock so the next scroll starts a new gesture. */
function settleWheelAxis(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 220))
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
  expect(toText(chart.axis)).toContain("┫")
  expect(toText(chart.axis)).toContain("┤")
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
      const guideRow = axisLines.findIndex((line) => line.includes("┫"))
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
  const chart = view(denseCandles, 40, 10, "YEAR")
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
  // Bottom three rows hold the volume pane, closed by ┴ on the axis.
  expect(plotLines.slice(-3).join("")).toMatch(braille)
  const volumeCells = cellsWithColor(chart.plot, RGBA.fromHex("#365747"))
  expect(volumeCells.some((cell) => cell.row >= 16)).toBe(true)
  expect(toText(chart.axis)).toContain("┴")
  expect(chart.timeAxis).toContain("09:55")
  expect(chart.timeAxis).toContain("16:25")
})

test("uses calendar labels for multi-day ranges", () => {
  const firstDay = new Date("2026-07-31T07:00:00Z").getTime()
  const weekCandles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
    timestamp: firstDay + Math.round((index * 7 * 24 * 60 * 60 * 1000) / 39),
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = view(weekCandles, 100, 20, "WEEK")
  expect(chart.timeAxis).toContain("31 Tem")
  expect(chart.timeAxis).toContain("07 Ağu")
  expect(chart.timeAxis).not.toContain(":")
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

  const chart = view(multiYearCandles, 100, 20, "FIVE_YEAR")
  expect(chart.timeAxis).toContain("17 Haz 25")
  expect(chart.timeAxis).toMatch(/\d{2} [A-ZÇĞİÖŞÜa-zçğıöşü]{3} 26/u)
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

  const chart = view(history, 80, 20, "FIVE_YEAR", 0, true)
  const plotLines = toText(chart.plot).split("\n")
  expect(plotLines).toHaveLength(18) // one row ceded to the reserved scrollbar row
  expect(chart.timeAxis).toMatch(/\d{2} [A-ZÇĞİÖŞÜa-zçğıöşü]{3}/u)
})

test("rasterizes a true-pixel bitmap for kitty terminals", () => {
  const result = renderCandleChartBitmapView(candles, 40, 10, "INTRADAY", 0, false, { width: 8, height: 16 })
  expect(typeof result).not.toBe("string")
  const chart = result as BitmapChartView
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
  expect(toText(chart.axis)).toContain("┫")
  expect(chart.timeAxis).toContain(":")
})

test("applies a live tick that arrives while candle history is loading", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16 })
  const deferred: { resolve?: (series: CandleSeries) => void } = {}
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
  chart.handleKey({ name: "down" } as KeyEvent)
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

  const internals = chart as unknown as {
    scrollOffset: number
    horizontalScrollBar: { x: number; y: number; viewportSize: number; slider: { viewPortSize: number } }
  }
  const mouse = createMockMouse(setup.renderer)
  const bar = internals.horizontalScrollBar
  const initialViewport = bar.viewportSize
  expect(initialViewport).toBeGreaterThan(0)

  // Wheel up at the right edge of the plot zooms in while the newest candle
  // stays anchored; wheel down zooms back out.
  await mouse.scroll(69, 10, "up")
  const zoomedViewport = bar.viewportSize
  expect(zoomedViewport).toBeLessThan(initialViewport)
  expect(internals.scrollOffset).toBe(0)
  await mouse.scroll(69, 10, "down")
  expect(bar.viewportSize).toBeGreaterThan(zoomedViewport)

  // Wheel up at the left edge anchors the oldest visible candle instead, so
  // the window slides back in history.
  await mouse.scroll(0, 10, "up")
  expect(internals.scrollOffset).toBeGreaterThan(0)

  // Trackpad-style horizontal scroll pans, over the plot and scrollbar alike.
  await settleWheelAxis()
  const beforePan = internals.scrollOffset
  await mouse.scroll(30, 10, "left")
  const panned = internals.scrollOffset
  expect(panned).toBeGreaterThan(beforePan)
  await mouse.scroll(bar.x + 10, bar.y, "right")
  expect(internals.scrollOffset).toBeLessThan(panned)

  // Vertical drift right after a horizontal swipe must not zoom.
  const viewportBeforeDrift = bar.viewportSize
  await mouse.scroll(30, 10, "up")
  expect(bar.viewportSize).toBe(viewportBeforeDrift)

  // Zooming out stops once the whole history fits in the viewport.
  await settleWheelAxis()
  for (let i = 0; i < 40; i++) await mouse.scroll(30, 10, "down")
  expect(bar.viewportSize).toBe(200)
  expect(internals.scrollOffset).toBe(0)

  // Zooming back in from the fully-out state must not leave the slider thumb
  // clamped to a stale sliver (OpenTUI clamps against the pre-update range).
  await mouse.scroll(30, 10, "up")
  expect(internals.horizontalScrollBar.slider.viewPortSize).toBe(bar.viewportSize)

  // Double-clicking the plot resets the zoom to the default candle width.
  for (let i = 0; i < 10; i++) await mouse.scroll(30, 10, "up")
  expect(bar.viewportSize).toBeLessThan(initialViewport)
  await mouse.doubleClick(30, 10)
  expect(bar.viewportSize).toBe(initialViewport)
  expect(internals.horizontalScrollBar.slider.viewPortSize).toBe(initialViewport)

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
  setup.renderer.root.add(chart.root)
  chart.setInstrument({ uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS" })

  await setup.waitForFrame((frame) => frame.includes("15m · O"))
  expect(requested[0]).toEqual({ range: "WEEK", interval: "MIN_15", target: "INSTRUMENT" })
  const targetFrame = setup.captureCharFrame()
  expect(targetFrame).toContain("Asset")
  expect(targetFrame).toContain("Stock")
  expect(targetFrame).toContain("Futures")
  expect(targetFrame).toContain("XU100")
  expect(targetFrame).toContain("XU030")

  chart.handleKey({ name: "down" } as KeyEvent)
  await setup.waitForFrame((frame) => frame.includes("30m · O"))
  expect(selected.at(-1)).toEqual({ range: "WEEK", interval: "MIN_30" })

  chart.handleKey({ name: "f" } as KeyEvent)
  await setup.waitForFrame(() => requested.length === 3)
  expect(requested.at(-1)?.target).toBe("BIST_100")
  expect(targets).toEqual(["BIST_100"])

  chart.handleKey({ name: "f" } as KeyEvent)
  await setup.waitForFrame(() => requested.length === 4)
  expect(requested.at(-1)?.target).toBe("BIST_30")

  chart.handleKey({ name: "f" } as KeyEvent)
  await setup.waitForFrame(() => requested.length === 5)
  expect(requested.at(-1)?.target).toBe("UNDERLYING")
  expect(targets).toEqual(["BIST_100", "BIST_30", "UNDERLYING"])

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

  chart.handleKey({ name: "home", shift: true } as KeyEvent)
  await setup.waitForFrame((frame) => frame.includes("09:55") && frame.includes("history · 5m · O 204,50"))

  chart.handleKey({ name: "end", shift: true } as KeyEvent)
  await setup.waitForFrame((frame) => frame.includes("14:25") && frame.includes("5m · O 209,90") && !frame.includes("history"))
  expect(requestCount).toBe(1)

  chart.destroy()
  setup.renderer.destroy()
})
