import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { CredentialsRequiredError } from "../api/index.ts"
import { DEFAULT_INTERVALS_BY_RANGE, type CandleSource } from "../market/candle.ts"
import type {
  EquityQuoteListener,
  EquityQuoteStream,
} from "../market/equity-quote-stream.ts"
import type { ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsSource } from "../market/news.ts"
import type { QuoteStream, QuoteUpdate, QuoteUpdateListener } from "../market/quote-stream.ts"
import { WatchlistScreen } from "./watchlist.ts"

class FakeQuoteStream implements QuoteStream {
  private listener: QuoteUpdateListener | null = null
  private connectionListener: ((connected: boolean) => void) | null = null
  startedSymbols: string[] | null = null
  stopped = false

  subscribe(listener: QuoteUpdateListener): void {
    this.listener = listener
  }
  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListener = listener
  }
  start(symbols: string[]): void {
    this.startedSymbols = symbols
  }
  stop(): void {
    this.stopped = true
  }
  emit(update: QuoteUpdate): void {
    this.listener?.(update)
  }
  emitConnection(connected: boolean): void {
    this.connectionListener?.(connected)
  }
}

class FakeEquityQuoteStream implements EquityQuoteStream {
  private listener: EquityQuoteListener | null = null
  private connectionListener: ((connected: boolean) => void) | null = null
  startedSymbols: string[] = []
  stopped = false

  subscribe(listener: EquityQuoteListener): void {
    this.listener = listener
  }
  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListener = listener
  }
  start(symbol: string): void {
    this.startedSymbols.push(symbol)
  }
  stop(): void {
    this.stopped = true
  }
  emit(symbol: string, lastPrice: number, timestamp: number): void {
    this.listener?.({ symbol, lastPrice, timestamp, sessionStatus: "OPEN" })
  }
  emitConnection(connected: boolean): void {
    this.connectionListener?.(connected)
  }
}

const instruments: ViopInstrumentSource = {
  async listInstruments() {
    return [
      { uid: "u1", symbol: "F_XU0300826", displayName: "XU030", underlyingSymbol: "XU030", lastPrice: 15910, changePercent: 0.4, volume: 2_000_000_000, currency: "TRY" },
      { uid: "u2", symbol: "F_THYAO0826", displayName: "THYAO", underlyingSymbol: "THYAO", lastPrice: 312.45, changePercent: -1.05, volume: 1_000_000_000, currency: "TRY" },
    ]
  },
}

const news: NewsSource = {
  async listNews() {
    return [{ uid: "n1", tag: "08 Ağu", headline: "BIST 30 güne yükselişle başladı", body: "Hacim arttı.", publishedAt: null, url: null, attachments: [] }]
  },
  async getArticle(uid) {
    return { uid, tag: "08 Ağu", headline: "BIST 30 güne yükselişle başladı", body: "Full body text.", publishedAt: null, url: null, attachments: [] }
  },
}

const candles: CandleSource = {
  async loadCandles(instrumentUid, range, interval) {
    return {
      instrumentUid,
      range,
      interval,
      availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
      intervalMs: 600_000,
      currency: "TRY",
      candles: [
        { timestamp: 1_786_083_900_000, open: 100, high: 104, low: 99, close: 103, volume: 10 },
        { timestamp: 1_786_084_500_000, open: 103, high: 105, low: 101, close: 102, volume: 12 },
      ],
    }
  },
}

test("renders the VIOP, chart, and news panels with instrument data", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })

  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("XU030"))
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("VIOP")
  expect(frame).toContain("Change")
  expect(frame).toContain("Volume ↓")
  expect(frame).toContain("Chart")
  expect(frame).toContain("News")
  expect(frame).toContain("XU030")

  screen.destroy()
  renderer.destroy()
})

test("shows a snapshot indicator until the stream reports live ticks", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })
  const quotes = new FakeQuoteStream()

  const screen = new WatchlistScreen(renderer, { instruments, candles, news, quotes })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("snapshot"))
  expect(captureCharFrame()).toContain("○ snapshot")

  quotes.emitConnection(true)
  await waitForFrame((f) => f.includes("live"))
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("VIOP  ● live")
  expect(frame).not.toContain("VIOP  ○ snapshot")

  screen.destroy()
  renderer.destroy()
})

test("applies live price ticks in place and subscribes with instrument symbols", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })
  const quotes = new FakeQuoteStream()

  const screen = new WatchlistScreen(renderer, { instruments, candles, news, quotes })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("THYAO"))
  expect(quotes.startedSymbols).toContain("F_THYAO0826")

  quotes.emit({ symbol: "F_THYAO0826", lastPrice: 320, sessionStatus: null, timestamp: 1 })
  await waitForFrame((f) => f.includes("320,00"))
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("320,00")
  expect(frame).toContain("+1.34%") // derived from the seeded reference close

  screen.destroy()
  expect(quotes.stopped).toBe(true)
  renderer.destroy()
})

test("sorts VIOP stocks by change or volume and preserves the selected stock", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const sortable: ViopInstrumentSource = {
    async listInstruments() {
      return [
        { uid: "c", symbol: "F_CCC0826", displayName: "CCC", underlyingSymbol: "CCC", lastPrice: 98, changePercent: -2, volume: 1_000_000_000, currency: "TRY" },
        { uid: "a", symbol: "F_AAA0826", displayName: "AAA", underlyingSymbol: "AAA", lastPrice: 101, changePercent: 1, volume: 3_000_000_000, currency: "TRY" },
        { uid: "b", symbol: "F_BBB0826", displayName: "BBB", underlyingSymbol: "BBB", lastPrice: 103, changePercent: 3, volume: 2_000_000_000, currency: "TRY" },
      ]
    },
  }
  const screen = new WatchlistScreen(renderer, { instruments: sortable, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const volumeFrame = await waitForFrame((frame) => frame.includes("Volume ↓") && frame.includes("AAA stock"))
  expect(viopRowSymbols(volumeFrame)).toEqual(["AAA", "BBB", "CCC"])
  expect(volumeFrame).toContain("AAA stock")

  await mockInput.typeText("c")
  const changeDescFrame = await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(changeDescFrame.indexOf("+3.00%")).toBeLessThan(changeDescFrame.indexOf("+1.00%"))
  expect(changeDescFrame.indexOf("+1.00%")).toBeLessThan(changeDescFrame.indexOf("-2.00%"))
  expect(changeDescFrame).toContain("AAA stock")
  expect(changeDescFrame).toMatch(/▶ AAA/)

  await mockInput.typeText("c")
  const changeAscFrame = await waitForFrame((frame) => frame.includes("Change ↑"))
  expect(changeAscFrame.indexOf("-2.00%")).toBeLessThan(changeAscFrame.indexOf("+1.00%"))
  expect(changeAscFrame.indexOf("+1.00%")).toBeLessThan(changeAscFrame.indexOf("+3.00%"))

  await mockInput.typeText("v")
  const volumeAgainFrame = await waitForFrame((frame) => frame.includes("Volume ↓"))
  expect(viopRowSymbols(volumeAgainFrame)).toEqual(["AAA", "BBB", "CCC"])

  screen.destroy()
  renderer.destroy()
})

function viopRowSymbols(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.slice(0, 36).match(/\b(AAA|BBB|CCC)\b/)?.[1])
    .filter((symbol): symbol is string => Boolean(symbol))
}

test("notifies onSessionExpired when the session cannot be restored", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 80, height: 20 })
  let expired = false
  const failing: ViopInstrumentSource = {
    async listInstruments() {
      throw new CredentialsRequiredError()
    },
  }

  const screen = new WatchlistScreen(renderer, {
    instruments: failing,
    candles,
    news,
    onSessionExpired: () => {
      expired = true
    },
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitFor(() => expired)
  expect(expired).toBe(true)

  screen.destroy()
  renderer.destroy()
})

test("opens a news article on double-click and returns on a second double-click", async () => {
  const { renderer, mockMouse, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 20,
  })

  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("BIST 30 güne"))
  const lines = captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("BIST 30 güne"))
  const x = lines[y]!.indexOf("BIST")

  await mockMouse.doubleClick(x, y)
  await waitForFrame((f) => f.includes("Full body text."))

  await mockMouse.doubleClick(x, 2) // double-click the reader to go back
  await waitForFrame((f) => !f.includes("Full body text.") && f.includes("BIST 30 güne"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Full body text.")

  screen.destroy()
  renderer.destroy()
})

test("opens a news article with its full body on Enter and returns on Backspace", async () => {
  const { renderer, mockInput, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 20,
  })

  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("BIST 30 güne"))

  mockInput.pressTab() // move focus to the chart panel
  mockInput.pressTab() // move focus to the news panel
  mockInput.pressEnter() // open the selected article
  await waitForFrame((f) => f.includes("Full body text."))

  mockInput.pressBackspace() // back to the headline list
  await waitForFrame((f) => !f.includes("Full body text.") && f.includes("BIST 30 güne"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Full body text.")

  screen.destroy()
  renderer.destroy()
})

test("switches chart ranges and timeframes from the focused chart panel", async () => {
  const { renderer, mockInput, waitForFrame, waitFor } = await createTestRenderer({ width: 120, height: 24 })
  const requested: Array<{ range: string; interval: string }> = []
  const trackingCandles: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      requested.push({ range, interval })
      return {
        ...(await candles.loadCandles(instrumentUid, range, interval)),
        range,
        interval,
      }
    },
  }
  const screen = new WatchlistScreen(renderer, { instruments, candles: trackingCandles, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("XU030"))
  await waitFor(() => requested.some((request) => request.range === "INTRADAY" && request.interval === "MIN_5"))
  mockInput.pressTab()
  mockInput.pressArrow("right")
  await waitFor(() => requested.some((request) => request.range === "WEEK" && request.interval === "HOUR_1"))
  mockInput.pressArrow("down")
  await waitFor(() => requested.some((request) => request.range === "WEEK" && request.interval === "MIN_10"))

  expect(requested).toContainEqual({ range: "WEEK", interval: "HOUR_1" })
  expect(requested).toContainEqual({ range: "WEEK", interval: "MIN_10" })
  screen.destroy()
  renderer.destroy()
})

test("keeps the chart usable in an 80-column terminal", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 80, height: 24 })
  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame(
    (value) => value.includes("102,00") && value.includes("5Y") && value.includes("5m") && /[█│━]/.test(value),
  )
  expect(frame).not.toContain("Chart needs more room")
  expect(frame).toMatch(/[█│━]/)

  mockInput.pressTab()
  mockInput.pressTab()
  const newsFrame = await waitForFrame((value) => value.includes("BIST 30 güne"))
  expect(newsFrame).toContain("News")

  screen.destroy()
  renderer.destroy()
})

test("streams the selected underlying stock into the live candle", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const equityQuotes = new FakeEquityQuoteStream()
  const stockFutures: ViopInstrumentSource = {
    async listInstruments() {
      return [
        { uid: "future-1", symbol: "F_TUPRS0826", displayName: "TUPRS", underlyingSymbol: "TUPRS", lastPrice: 329.85, changePercent: 1.2, volume: 2_000_000_000, currency: "TRY" },
        { uid: "future-2", symbol: "F_THYAO0826", displayName: "THYAO", underlyingSymbol: "THYAO", lastPrice: 312.45, changePercent: -1.05, volume: 1_000_000_000, currency: "TRY" },
      ]
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments: stockFutures,
    candles,
    news,
    equityQuotes,
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("TUPRS stock"))
  expect(equityQuotes.startedSymbols).toEqual(["TUPRS"])
  equityQuotes.emitConnection(true)
  equityQuotes.emit("TUPRS", 110, 1_786_084_800_000)
  const liveFrame = await waitForFrame((frame) => frame.includes("110,00") && frame.includes("● live"))
  expect(liveFrame).toContain("TUPRS stock")

  mockInput.pressArrow("down")
  await waitForFrame((frame) => frame.includes("THYAO stock"))
  expect(equityQuotes.startedSymbols).toEqual(["TUPRS", "THYAO"])

  screen.destroy()
  expect(equityQuotes.stopped).toBeTrue()
  renderer.destroy()
})
