import { expect, test } from "bun:test"
import { StyledText, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { DEFAULT_INTERVALS_BY_RANGE, type Candle, type CandleSeries, type CandleSource } from "../market/candle.ts"
import { aggregateCandles, CandlestickChart, renderCandleChart } from "./candlestick-chart.ts"

const candles: Candle[] = [
  { timestamp: 1000, open: 10, high: 13, low: 9, close: 12, volume: 10 },
  { timestamp: 2000, open: 12, high: 14, low: 11, close: 13, volume: 20 },
  { timestamp: 3000, open: 13, high: 15, low: 10, close: 11, volume: 30 },
  { timestamp: 4000, open: 11, high: 12, low: 8, close: 9, volume: 40 },
]

test("aggregates a full candle range to the terminal capacity", () => {
  const result = aggregateCandles(candles, 2)

  expect(result).toEqual([
    { timestamp: 2000, open: 10, high: 14, low: 9, close: 13, volume: 30 },
    { timestamp: 4000, open: 13, high: 15, low: 8, close: 9, volume: 70 },
  ])
})

test("renders colored candle bodies, wicks, axes, and timestamps", () => {
  const chart = renderCandleChart(candles, 40, 10, "INTRADAY")
  expect(chart).toBeInstanceOf(StyledText)

  const text = (chart as StyledText).chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("█")
  expect(text).toContain("│")
  expect(text.split("\n")).toHaveLength(10)
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
