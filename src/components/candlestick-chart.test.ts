import { expect, test } from "bun:test"
import { StyledText, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleSeries, type CandleSource } from "../market/candle.ts"
import { CandlestickChart, renderCandleChart, selectVisibleCandles } from "./candlestick-chart.ts"

const candles: Candle[] = [
  { timestamp: 1000, open: 10, high: 13, low: 9, close: 12, volume: 10 },
  { timestamp: 2000, open: 12, high: 14, low: 11, close: 13, volume: 20 },
  { timestamp: 3000, open: 13, high: 15, low: 10, close: 11, volume: 30 },
  { timestamp: 4000, open: 11, high: 12, low: 8, close: 9, volume: 40 },
]

test("selects newest raw candles and scrolls backward without aggregating them", () => {
  expect(selectVisibleCandles(candles, 2)).toEqual(candles.slice(2))
  expect(selectVisibleCandles(candles, 2, 1)).toEqual(candles.slice(1, 3))
  expect(selectVisibleCandles(candles, 2, 100)).toEqual(candles.slice(0, 2))
  expect(selectVisibleCandles(candles, 2)[0]).toBe(candles[2])
})

test("renders narrow candle bodies, wicks, axes, and timestamps", () => {
  const chart = renderCandleChart(candles, 40, 10, "INTRADAY")
  expect(chart).toBeInstanceOf(StyledText)

  const text = (chart as StyledText).chunks.map((chunk) => chunk.text).join("")
  expect(text).toMatch(/[┃╻╹╽╿]/)
  expect(text).not.toContain("█")
  expect(text).toContain("│")
  expect(text.split("\n")).toHaveLength(10)
})

test("fills the complete body between open and close", () => {
  const chart = renderCandleChart([
    { timestamp: 1000, open: 100, high: 110, low: 100, close: 110, volume: null },
  ], 30, 20, "INTRADAY") as StyledText
  const plotColumn = 18
  const bodyRows = chart.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")
    .slice(0, -1)
    .flatMap((line, row) => /[┃╻╹╽╿]/.test(line[plotColumn] ?? "") ? [row] : [])

  expect(bodyRows.length).toBeGreaterThan(10)
  expect(Math.max(...bodyRows) - Math.min(...bodyRows) + 1).toBe(bodyRows.length)
})

test("spaces and right-aligns candles with a current-price guide", () => {
  const chart = renderCandleChart(candles, 40, 10, "INTRADAY") as StyledText
  const lines = chart.chunks.map((chunk) => chunk.text).join("").split("\n")
  const plotWidth = 30
  const candlePositions = lines
    .slice(0, -1)
    .flatMap((line) => Array.from(line.slice(0, plotWidth)).flatMap((glyph, index) => /[┃╻╹╽╿│╷╵]/.test(glyph) ? [index] : []))

  expect(Math.min(...candlePositions)).toBeGreaterThanOrEqual(22)
  expect(candlePositions.every((position) => position % 2 === 0)).toBe(true)
  expect(lines.some((line) => line.includes("┫") && line.includes("9,0000"))).toBe(true)
})

test("uses every plot column for a dense candle history", () => {
  const denseCandles: Candle[] = Array.from({ length: 24 }, (_, index) => ({
    timestamp: index * 1000,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1,
  }))
  const chart = renderCandleChart(denseCandles, 40, 10, "YEAR") as StyledText
  const plotLines = chart.chunks.map((chunk) => chunk.text).join("").split("\n").slice(0, -1)

  const bodyGlyphs = /[┃╻╹╽╿]/
  expect(Math.max(...plotLines.map((line) => Array.from(line.slice(0, 30)).filter((glyph) => bodyGlyphs.test(glyph)).length))).toBe(24)
  expect(plotLines.join("\n")).not.toContain("█")
})

test("adds volume, chart grid, and intermediate intraday timestamps when space allows", () => {
  const sessionStart = new Date("2026-08-07T06:55:00Z").getTime()
  const sessionCandles: Candle[] = Array.from({ length: 50 }, (_, index) => ({
    timestamp: sessionStart + index * 10 * 60 * 1000,
    open: 200 + index,
    high: 202 + index,
    low: 199 + index,
    close: 201 + index,
    volume: (index + 1) * 100,
  }))

  const chart = renderCandleChart(sessionCandles, 100, 20, "INTRADAY") as StyledText
  const lines = chart.chunks.map((chunk) => chunk.text).join("").split("\n")
  const timeAxis = lines.at(-1) ?? ""

  expect(lines).toHaveLength(20)
  expect(timeAxis).toContain("09:55")
  expect(timeAxis).toContain("14:05")
  expect(timeAxis).toContain("18:05")
  expect(lines.slice(-4, -1).join("")).toContain("┃")
  expect(lines.slice(0, -4).join("")).toContain("┊")
  expect(lines.slice(0, -4).join("")).toContain("┼")
})

test("uses calendar labels for multi-day ranges", () => {
  const firstDay = new Date("2026-07-31T07:00:00Z").getTime()
  const weekCandles: Candle[] = Array.from({ length: 50 }, (_, index) => ({
    timestamp: firstDay + Math.round((index * 7 * 24 * 60 * 60 * 1000) / 49),
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = renderCandleChart(weekCandles, 100, 20, "WEEK") as StyledText
  const timeAxis = chart.chunks.map((chunk) => chunk.text).join("").split("\n").at(-1) ?? ""

  expect(timeAxis).toContain("31 Tem")
  expect(timeAxis).toContain("07 Ağu")
  expect(timeAxis).not.toContain(":")
})

test("adds years to calendar labels only when the visible window crosses a year", () => {
  const firstDay = new Date("2025-06-17T07:00:00Z").getTime()
  const multiYearCandles: Candle[] = Array.from({ length: 50 }, (_, index) => ({
    timestamp: firstDay + Math.round((index * 18 * 30 * 24 * 60 * 60 * 1000) / 49),
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = renderCandleChart(multiYearCandles, 100, 20, "FIVE_YEAR") as StyledText
  const timeAxis = chart.chunks.map((chunk) => chunk.text).join("").split("\n").at(-1) ?? ""

  expect(timeAxis).toContain("17 Haz 25")
  expect(timeAxis).toMatch(/\d{2} [A-ZÇĞİÖŞÜa-zçğıöşü]{3} 26/u)
})

test("keeps the calendar axis above the native scrollbar row", () => {
  const firstDay = new Date("2026-07-31T07:00:00Z").getTime()
  const history: Candle[] = Array.from({ length: 100 }, (_, index) => ({
    timestamp: firstDay + index * 24 * 60 * 60 * 1000,
    open: 150 + index,
    high: 152 + index,
    low: 149 + index,
    close: 151 + index,
    volume: 100 + index,
  }))

  const chart = renderCandleChart(history, 80, 20, "FIVE_YEAR", 0, true) as StyledText
  const lines = chart.chunks.map((chunk) => chunk.text).join("").split("\n")

  expect(lines).toHaveLength(20)
  expect(lines.at(-2)).toMatch(/\d{2} [A-ZÇĞİÖŞÜa-zçğıöşü]{3}/u)
  expect(lines.at(-1)?.trim()).toBe("")
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

  const newestFrame = await setup.waitForFrame(
    (frame) => frame.includes("12:25") && frame.includes("◀") && frame.includes("▶") && !frame.includes("history"),
  )
  expect(newestFrame).toContain("█")
  await setup.mockMouse.click(0, 17)
  await setup.waitForFrame((frame) => frame.includes("history"))
  expect(requestCount).toBe(1)

  chart.handleKey({ name: "home", shift: true } as KeyEvent)
  await setup.waitForFrame((frame) => frame.includes("09:55") && frame.includes("history · 5m · O 206,90"))

  chart.handleKey({ name: "end", shift: true } as KeyEvent)
  await setup.waitForFrame((frame) => frame.includes("12:25") && frame.includes("5m · O 209,90") && !frame.includes("history"))
  expect(requestCount).toBe(1)

  chart.destroy()
  setup.renderer.destroy()
})
