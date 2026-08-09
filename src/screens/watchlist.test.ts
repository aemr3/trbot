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
import type {
  AccountLiveUpdate,
  AccountLiveUpdateListener,
  AccountSource,
  AccountStream,
} from "../trading/account.ts"
import type {
  PlaceViopOrderRequest,
  ViopOrderCancellationSource,
  ViopOrderSource,
} from "../trading/order.ts"
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

class FakeAccountStream implements AccountStream {
  private listener: AccountLiveUpdateListener | null = null
  private connectionListener: ((connected: boolean) => void) | null = null
  pendingOrders: string[] = []
  started = false
  stopped = false

  subscribe(listener: AccountLiveUpdateListener): void {
    this.listener = listener
  }
  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListener = listener
  }
  setPendingOrders(orderUids: string[]): void {
    this.pendingOrders = orderUids
  }
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  emit(update: AccountLiveUpdate): void {
    this.listener?.(update)
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
  async loadContractDetails() {
    return {
      initialCollateral: 4_719.55,
      leverage: 4.43,
      contractSize: 100,
      expiryDate: "31/08/2026",
      sessionHigh: 210,
      sessionLow: 195,
      settlementPrice: 209.2,
      previousSettlementPrice: 195.5,
      volume: 1_040_270_720,
      openInterest: 54_068,
    }
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

const account: AccountSource = {
  async loadAccount() {
    return {
      portfolio: {
        currency: "TRY",
        totalCollateral: 125_000,
        availableCollateral: 45_000,
        dailyProfitLoss: 2_500,
        dailyProfitLossPercent: 2.04,
        periodProfitLoss: 5_000,
        periodProfitLossPercent: 4.17,
      },
      orders: [{
        uid: "order-1",
        title: "THYAO alış",
        description: "2 kontrat",
        value: "Bekliyor",
        status: "pending",
      }],
      positions: [{
        uid: "position-1",
        symbol: "F_THYAO0826",
        displayName: "THYAO",
        quantity: 2,
        averageCost: 300,
        currentPrice: 312,
        unrealizedProfitLoss: 240,
        currency: "TRY",
        multiplier: 10,
      }],
      updatedAt: 1,
    }
  },
}

function fakeOrderSource(placed: PlaceViopOrderRequest[] = []): ViopOrderSource {
  return {
    async prepareOrder({ side }) {
      return {
        lowerLimit: 14_000,
        upperLimit: 17_000,
        lastPrice: 15_910,
        ask: 15_911,
        bid: 15_909,
        priceScale: 2,
        contractSize: 10,
        initialCollateral: 4_719.55,
        availableCollateral: 45_000,
        positionIntent: side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
      }
    },
    async placeOrder(request) {
      placed.push(request)
      return { uid: "new-order", status: "PENDING", description: "Bekliyor" }
    },
  }
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
  expect(frame).toContain("1 contract")
  expect(frame).toContain("Order size  ₺1.591.000,00")
  expect(frame).toContain("Required    ₺4.719,55")
  expect(frame).toContain("Stats · High ₺210,00 · Low ₺195,00")
  expect(frame).toContain("Vol 1.040.270.720 · OI 54.068")

  screen.destroy()
  renderer.destroy()
})

test("opens modal buy and sell tickets and submits simulated market orders at exchange limits", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 160, height: 30, kittyKeyboard: true })
  const placed: PlaceViopOrderRequest[] = []
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    orders: fakeOrderSource(placed),
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  await mockInput.typeText("b")
  const buyTicket = await waitForFrame((frame) => frame.includes("Buy XU030 08/26") && frame.includes("Upper limit"))
  expect(buyTicket).toContain("VIOP")
  expect(buyTicket).toContain("News")
  expect(buyTicket).toContain("╭")
  expect(buyTicket).toContain("₺15.910,00")
  await mockInput.typeText("m")
  await mockInput.typeText("r")
  await waitForFrame((frame) => frame.includes("Review buy order") && frame.includes("₺17.000,00"))
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Order submitted"))
  expect(placed[0]).toMatchObject({ side: "BUY", quantity: 1, limitPrice: 17_000 })

  mockInput.pressEscape()
  await waitForFrame((frame) => frame.includes("XU030 stock") && !frame.includes("Order submitted"))
  await mockInput.typeText("s")
  await waitForFrame((frame) => frame.includes("Sell XU030 08/26"))

  screen.destroy()
  renderer.destroy()
})

test("shows portfolio, orders, and positions in tabs below the chart", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 160, height: 30 })
  const screen = new WatchlistScreen(renderer, { instruments, candles, news, account })
  renderer.root.add(screen.root)
  screen.mount()

  const portfolioFrame = await waitForFrame((frame) => frame.includes("Available") && frame.includes("₺125.000,00"))
  expect(portfolioFrame).toContain("Portfolio")
  expect(portfolioFrame).toContain("Orders")
  expect(portfolioFrame).toContain("Positions")

  mockInput.pressTab()
  mockInput.pressTab()
  mockInput.pressArrow("right")
  const ordersFrame = await waitForFrame((frame) => frame.includes("THYAO alış"))
  expect(ordersFrame).toContain("PENDING")

  mockInput.pressArrow("right")
  const positionsFrame = await waitForFrame((frame) => frame.includes("300,00→312,00"))
  expect(positionsFrame).toContain("+₺240,00")

  screen.destroy()
  renderer.destroy()
})

test("applies live account, order, and futures price updates", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 160, height: 30 })
  const quotes = new FakeQuoteStream()
  const accountStream = new FakeAccountStream()
  const screen = new WatchlistScreen(renderer, { instruments, candles, news, account, accountStream, quotes })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("₺45.000,00") && frame.includes("○ sync"))
  expect(accountStream.started).toBe(true)
  expect(accountStream.pendingOrders).toEqual(["order-1"])

  accountStream.emitConnection(true)
  accountStream.emit({ type: "collateral", availableCollateral: 48_000 })
  const livePortfolio = await waitForFrame((frame) => frame.includes("₺48.000,00") && frame.includes("● live"))
  expect(livePortfolio).toContain("Available")

  mockInput.pressTab()
  mockInput.pressTab()
  mockInput.pressArrow("right")
  accountStream.emit({
    type: "order",
    uid: "order-1",
    status: "completed",
    providerStatus: "FILLED",
    description: "Gerçekleşti",
  })
  const orderFrame = await waitForFrame((frame) => frame.includes("DONE") && frame.includes("Gerçekleşti"))
  expect(orderFrame).toContain("THYAO alış")
  expect(accountStream.pendingOrders).toEqual([])

  mockInput.pressArrow("right")
  quotes.emit({ symbol: "F_THYAO0826", lastPrice: 320, sessionStatus: "OPEN", timestamp: 2 })
  const pricedPosition = await waitForFrame((frame) => frame.includes("300,00→320,00") && frame.includes("+₺400,00"))
  expect(pricedPosition).toContain("THYAO")

  accountStream.emit({ type: "position", uid: "position-1", quantity: 3, averageCost: 305, country: "TR" })
  const updatedPosition = await waitForFrame((frame) => frame.includes("305,00→320,00") && frame.includes("+₺450,00"))
  expect(updatedPosition).toContain("3x")

  screen.destroy()
  expect(accountStream.stopped).toBe(true)
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
  const { renderer, mockInput, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({ width: 120, height: 24 })
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
  await renderOnce()
  expect(captureCharFrame()).toContain("Volume ↓")

  mockInput.pressKey("c", { shift: true })
  const changeDescFrame = await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(changeDescFrame.indexOf("+3.00%")).toBeLessThan(changeDescFrame.indexOf("+1.00%"))
  expect(changeDescFrame.indexOf("+1.00%")).toBeLessThan(changeDescFrame.indexOf("-2.00%"))
  expect(changeDescFrame).toContain("AAA stock")
  expect(changeDescFrame).toMatch(/▶ AAA/)

  mockInput.pressKey("c", { shift: true })
  const changeAscFrame = await waitForFrame((frame) => frame.includes("Change ↑"))
  expect(changeAscFrame.indexOf("-2.00%")).toBeLessThan(changeAscFrame.indexOf("+1.00%"))
  expect(changeAscFrame.indexOf("+1.00%")).toBeLessThan(changeAscFrame.indexOf("+3.00%"))

  mockInput.pressKey("v", { shift: true })
  const volumeAgainFrame = await waitForFrame((frame) => frame.includes("Volume ↓"))
  expect(viopRowSymbols(volumeAgainFrame)).toEqual(["AAA", "BBB", "CCC"])

  screen.destroy()
  renderer.destroy()
})

test("cancels every pending VIOP order immediately with lowercase c", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const cancelled: string[][] = []
  const cancellation: ViopOrderCancellationSource = {
    async listPendingOrders() {
      return [
        { uid: "order-1", title: "First", description: null },
        { uid: "order-2", title: "Second", description: null },
      ]
    },
    async cancelPendingOrders({ orderUids }) {
      cancelled.push(orderUids)
      return { cancelledOrderUids: orderUids, failures: [] }
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    orderCancellation: cancellation,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  mockInput.pressKey("c", { shift: true })
  await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(cancelled).toHaveLength(0)
  await mockInput.typeText("c")
  await waitForFrame((frame) => frame.includes("Cancelled 2 pending VIOP orders."))
  expect(cancelled).toEqual([["order-1", "order-2"]])

  screen.destroy()
  renderer.destroy()
})

test("restores and reports list and chart display choices", async () => {
  const { renderer, mockInput, waitForFrame, waitFor } = await createTestRenderer({ width: 120, height: 24 })
  const changes: Array<{
    instrumentSort: string
    sortDirection: string
    candleRange: string
    candleInterval: string
    selectedInstrumentUid: string | null
    orderKind: string
  }> = []
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    orders: fakeOrderSource(),
    preferences: {
      instrumentSort: "change",
      sortDirection: "asc",
      candleRange: "WEEK",
      candleInterval: "MIN_15",
      selectedInstrumentUid: "u1",
      orderKind: "LIMIT",
    },
    onPreferencesChange: (preferences) => changes.push(preferences),
  })
  renderer.root.add(screen.root)
  screen.mount()

  const restored = await waitForFrame((frame) => frame.includes("Change ↑") && frame.includes("15m · O"))
  expect(restored).toContain("XU030 stock")

  mockInput.pressArrow("down")
  await waitForFrame((frame) => frame.includes("THYAO stock"))
  expect(changes.at(-1)).toMatchObject({ selectedInstrumentUid: "u2" })

  mockInput.pressKey("c", { shift: true })
  await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(changes.at(-1)).toMatchObject({ instrumentSort: "change", sortDirection: "desc" })

  mockInput.pressTab()
  mockInput.pressArrow("right")
  await waitFor(() => changes.some((preferences) => preferences.candleRange === "MONTH"))
  expect(changes.at(-1)).toMatchObject({ candleRange: "MONTH", candleInterval: "HOUR_1" })

  await mockInput.typeText("b")
  await waitForFrame((frame) => frame.includes("Buy THYAO 08/26"))
  await mockInput.typeText("m")
  await waitForFrame((frame) => frame.includes("Simulated market"))
  await waitFor(() => changes.some((preferences) => preferences.orderKind === "MARKETABLE_LIMIT"))

  screen.destroy()
  renderer.destroy()
})

test("falls back to an available contract when the saved contract no longer exists", async () => {
  const { renderer, waitForFrame, waitFor } = await createTestRenderer({ width: 120, height: 24 })
  const selectedInstrumentUids: Array<string | null> = []
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    preferences: {
      instrumentSort: "volume",
      sortDirection: "desc",
      candleRange: "INTRADAY",
      candleInterval: "MIN_5",
      selectedInstrumentUid: "expired-contract",
      orderKind: "LIMIT",
    },
    onPreferencesChange: (preferences) => selectedInstrumentUids.push(preferences.selectedInstrumentUid),
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("XU030 stock"))
  await waitFor(() => selectedInstrumentUids.includes("u1"))

  screen.destroy()
  renderer.destroy()
})

function viopRowSymbols(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.slice(0, 36).match(/^[ ▶]{3}(AAA|BBB|CCC)\s+\d/)?.[1])
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
  mockInput.pressTab() // move focus to the account panel
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

test("routes modified arrows to horizontal chart scrolling", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 120,
    height: 24,
    kittyKeyboard: true,
  })
  const sessionStart = new Date("2026-08-07T06:55:00Z").getTime()
  const historyCandles: CandleSource = {
    async loadCandles(instrumentUid, range, interval) {
      return {
        instrumentUid,
        range,
        interval,
        availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
        intervalMs: 300_000,
        currency: "TRY",
        candles: Array.from({ length: 100 }, (_, index) => ({
          timestamp: sessionStart + index * 300_000,
          open: 200 + index / 10,
          high: 200.2 + index / 10,
          low: 199.8 + index / 10,
          close: 200.1 + index / 10,
          volume: null,
        })),
      }
    },
  }
  const screen = new WatchlistScreen(renderer, { instruments, candles: historyCandles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const newestFrame = await waitForFrame((frame) => frame.includes("XU030 stock") && frame.includes("◀") && !frame.includes("history"))
  expect(newestFrame).toContain("█")
  mockInput.pressTab()
  mockInput.pressArrow("left", { shift: true })
  await waitForFrame((frame) => frame.includes("history"))

  mockInput.pressArrow("right", { shift: true })
  await waitForFrame((frame) => !frame.includes("history"))

  screen.destroy()
  renderer.destroy()
})

test("keeps the chart usable in an 80-column terminal", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 80, height: 24 })
  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame(
    (value) => value.includes("102,00") && value.includes("5Y") && value.includes("5m") && /[┃╻╹╽╿│]/.test(value),
  )
  expect(frame).not.toContain("Chart needs more room")
  expect(frame).toMatch(/[┃╻╹╽╿│]/)

  mockInput.pressTab()
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
