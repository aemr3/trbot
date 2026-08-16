import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatGptAccount } from "../ai/chatgpt-account.ts"
import { AuthenticationError } from "../api/index.ts"
import type {
  BrokerageDistribution,
  BrokerageDistributionRequest,
  BrokerageDistributionSource,
} from "../market/brokerage.ts"
import type { SettlementAnalysis, SettlementRequest, SettlementSource } from "../market/settlement.ts"
import { DEFAULT_INTERVALS_BY_RANGE, type CandleSource } from "../market/candle.ts"
import { ApplicationLog } from "../logging/application-log.ts"
import type {
  DepthBook,
  DepthBookListener,
  DepthStatus,
  DepthStatusListener,
  DepthStream,
} from "../market/depth.ts"
import { memberFeatureSet, type MemberFeatureSource } from "../member/features.ts"
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
  ViopPositionExitSource,
} from "../trading/order.ts"
import { LogsScreen } from "./logs.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"
import { WatchlistScreen } from "./watchlist.ts"
import type { WatchlistPreferences } from "./watchlist-preferences.ts"

// Tab cycles the panels in this order from a freshly mounted screen. Naming the
// destination keeps the tests readable, and adding a panel only moves this list.
const FOCUS_ORDER = ["instruments", "chart", "depth", "brokers", "account", "news"] as const

function focusPanel(mockInput: { pressTab(): void }, panel: (typeof FOCUS_ORDER)[number]): void {
  for (let step = 0; step < FOCUS_ORDER.indexOf(panel); step++) mockInput.pressTab()
}

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
        currentPositionQuantity: 0,
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

test("switches between selected-stock and index news feeds", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const requests: Array<string | null> = []
  const scopedNews: NewsSource = {
    async listNews(options = {}) {
      requests.push(options.instrumentUid ?? null)
      const indexFeed = options.instrumentUid === undefined
      return [{
        uid: indexFeed ? "index-news" : "stock-news",
        tag: "11 Ağu",
        headline: indexFeed ? "BIST 100 closes higher" : "Selected stock announces results",
        body: "",
        publishedAt: null,
        url: null,
        attachments: [],
      }]
    },
    async getArticle() {
      return null
    },
  }
  const screen = new WatchlistScreen(renderer, { instruments, candles, news: scopedNews })
  renderer.root.add(screen.root)
  screen.mount()

  const stockFrame = await waitForFrame((frame) => frame.includes("Selected stock announces results"))
  expect(stockFrame).toContain("Feed")
  expect(stockFrame).toContain("Stock")
  expect(stockFrame).toContain("Index")
  expect(requests.at(-1)).toBe("u1")

  focusPanel(mockInput, "news")
  mockInput.pressArrow("right")
  await waitForFrame((frame) => frame.includes("BIST 100 closes higher"))
  expect(requests.at(-1)).toBeNull()

  mockInput.pressArrow("left")
  await waitForFrame((frame) => frame.includes("Selected stock announces results"))
  expect(requests.at(-1)).toBe("u1")

  screen.destroy()
  renderer.destroy()
})

test("opens application logs and returns to the watchlist", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true })
  const logs = new ApplicationLog()
  logs.error("Market data", Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: '{"detail":"Unknown parameter: candles"}',
  }))
  let workspace: TradingWorkspaceScreen | null = null
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    logs,
    manageInput: false,
    onOpenLogs: () => workspace?.selectTab("logs"),
  })
  const logScreen = new LogsScreen(renderer, { logs, onClose: () => workspace?.selectTab("watchlist") })
  workspace = new TradingWorkspaceScreen(renderer, { watchlist: screen, logs: logScreen })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  mockInput.pressKey("g", { shift: true })
  const logFrame = await waitForFrame((frame) => frame.includes("APPLICATION LOGS") && frame.includes("Unknown parameter"))
  expect(logFrame).toContain("Market data")
  expect(logFrame).toContain("statusCode")
  mockInput.pressKey("w", { shift: true })
  await waitForFrame((frame) => frame.includes("XU030 stock") && !frame.includes("APPLICATION LOGS"))

  workspace.destroy()
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
  const { renderer, mockInput, mockMouse, waitForFrame } = await createTestRenderer({ width: 160, height: 30 })
  const screen = new WatchlistScreen(renderer, { instruments, candles, news, account })
  renderer.root.add(screen.root)
  screen.mount()

  const portfolioFrame = await waitForFrame((frame) => frame.includes("Available") && frame.includes("₺125.000,00"))
  expect(portfolioFrame).toContain("Portfolio")
  expect(portfolioFrame).toContain("Orders")
  expect(portfolioFrame).toContain("Positions")
  expect(portfolioFrame).toContain("  Portfolio    Orders    Positions ")

  focusPanel(mockInput, "account")
  mockInput.pressArrow("right")
  const ordersFrame = await waitForFrame((frame) => frame.includes("THYAO alış"))
  expect(ordersFrame).toContain("PENDING")

  mockInput.pressArrow("right")
  const positionsFrame = await waitForFrame((frame) => frame.includes("300,00→312,00"))
  expect(positionsFrame).toContain("+₺240,00")

  const lines = positionsFrame.split("\n")
  const positionY = lines.findIndex((line) => line.includes("300,00→312,00"))
  const positionX = lines[positionY]?.indexOf("THYAO") ?? -1
  expect(positionX).toBeGreaterThanOrEqual(0)
  await mockMouse.click(positionX, positionY)
  await waitForFrame((frame) => frame.includes("Chart  THYAO stock") && frame.includes("▶ THYAO"))

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

  focusPanel(mockInput, "account")
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

test("refreshes snapshot volumes and re-sorts without replacing live prices", async () => {
  const { renderer, waitFor, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  let calls = 0
  const refreshing: ViopInstrumentSource = {
    async listInstruments() {
      calls++
      if (calls === 1) {
        return [
          { uid: "a", symbol: "F_AAA0826", displayName: "AAA", underlyingSymbol: "AAA", lastPrice: 101, changePercent: 1, volume: 3_000, currency: "TRY" },
          { uid: "b", symbol: "F_BBB0826", displayName: "BBB", underlyingSymbol: "BBB", lastPrice: 102, changePercent: 2, volume: 2_000, currency: "TRY" },
          { uid: "c", symbol: "F_CCC0826", displayName: "CCC", underlyingSymbol: "CCC", lastPrice: 103, changePercent: 3, volume: 1_000, currency: "TRY" },
        ]
      }
      return [
        { uid: "a", symbol: "F_AAA0826", displayName: "AAA", underlyingSymbol: "AAA", lastPrice: 1, changePercent: -99, volume: 1_000, currency: "TRY" },
        { uid: "b", symbol: "F_BBB0826", displayName: "BBB", underlyingSymbol: "BBB", lastPrice: 1, changePercent: -99, volume: 2_000, currency: "TRY" },
        { uid: "c", symbol: "F_CCC0826", displayName: "CCC", underlyingSymbol: "CCC", lastPrice: 1, changePercent: -99, volume: 4_000, currency: "TRY" },
      ]
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments: refreshing,
    candles,
    news,
    instrumentIntervalMs: 10,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const initialFrame = await waitForFrame((frame) => frame.includes("AAA stock"))
  expect(viopRowSymbols(initialFrame)).toEqual(["AAA", "BBB", "CCC"])
  await waitFor(() => calls >= 2)
  const refreshedFrame = await waitForFrame((frame) => viopRowSymbols(frame).join(",") === "CCC,BBB,AAA")
  expect(refreshedFrame).toContain("103,00")
  expect(refreshedFrame).toContain("+3.00%")

  screen.destroy()
  renderer.destroy()
})

// A session left running past a settlement keeps its live prices but must pick
// up the new daily-change reference, or every row reports the previous day's
// change against a stale previous close.
test("re-derives the daily change reference when the snapshot rolls into a new session", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const quotes = new FakeQuoteStream()
  let rolledOver = false
  const rollingOver: ViopInstrumentSource = {
    async listInstruments() {
      // Yesterday closed 10% up at 110 (reference 100); today the same price is
      // only 2% above the new previous close.
      const changePercent = rolledOver ? 2 : 10
      return [
        { uid: "a", symbol: "F_AAA0826", displayName: "AAA", underlyingSymbol: "AAA", lastPrice: 110, changePercent, volume: 3_000, currency: "TRY" },
      ]
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments: rollingOver,
    candles,
    news,
    quotes,
    instrumentIntervalMs: 10,
  })
  renderer.root.add(screen.root)
  screen.mount()

  expect(await waitForFrame((frame) => frame.includes("+10.00%"))).toContain("110,00")

  rolledOver = true
  const rolledFrame = await waitForFrame((frame) => frame.includes("+2.00%"))
  expect(rolledFrame).not.toContain("+10.00%")

  // Later ticks are measured against the new reference, not the stale one.
  quotes.emit({ symbol: "F_AAA0826", lastPrice: 113.4, sessionStatus: "OPEN", timestamp: 1 })
  expect(await waitForFrame((frame) => frame.includes("+5.15%"))).toContain("113,40")

  screen.destroy()
  renderer.destroy()
})

// Session stats, volume, open interest and the settlement prices only arrive
// with the contract detail call, which used to run on selection alone.
test("keeps the selected contract stats fresh while the selection stays put", async () => {
  const { renderer, waitFor, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 24 })
  let openInterest = 1_000
  let failing = false
  let detailCalls = 0
  const refreshingDetails: ViopInstrumentSource = {
    async listInstruments() {
      return [
        { uid: "a", symbol: "F_AAA0826", displayName: "AAA", underlyingSymbol: "AAA", lastPrice: 110, changePercent: 2, volume: 3_000, currency: "TRY" },
      ]
    },
    async loadContractDetails() {
      detailCalls++
      if (failing) throw new Error("contract details are down")
      return {
        initialCollateral: 1_000,
        leverage: 3,
        contractSize: 100,
        expiryDate: "31/08/2026",
        sessionHigh: 112,
        sessionLow: 108,
        settlementPrice: null,
        previousSettlementPrice: 107.84,
        volume: 5_000,
        openInterest,
      }
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments: refreshingDetails,
    candles,
    news,
    instrumentIntervalMs: 10,
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("OI 1.000"))

  openInterest = 2_000
  await waitForFrame((frame) => frame.includes("OI 2.000"))

  // A failed background refresh keeps the last good stats on screen.
  failing = true
  const callsBeforeFailure = detailCalls
  await waitFor(() => detailCalls > callsBeforeFailure + 1)
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("OI 2.000")
  expect(frame).not.toContain("Contract details unavailable")

  screen.destroy()
  renderer.destroy()
})

test("requires lowercase c twice before cancelling every pending VIOP order", async () => {
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
  await waitForFrame((frame) => frame.includes("Press c again to cancel all pending orders."))
  expect(cancelled).toHaveLength(0)
  mockInput.pressArrow("down")
  await waitForFrame((frame) => !frame.includes("Press c again to cancel all pending orders."))
  await mockInput.typeText("c")
  await waitForFrame((frame) => frame.includes("Press c again to cancel all pending orders."))
  expect(cancelled).toHaveLength(0)
  await mockInput.typeText("c")
  await waitForFrame((frame) => frame.includes("Cancelled 2 pending VIOP orders."))
  expect(cancelled).toEqual([["order-1", "order-2"]])

  screen.destroy()
  renderer.destroy()
})

test("requires lowercase x twice before submitting exits for every VIOP position", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  let exits = 0
  const positionExit: ViopPositionExitSource = {
    async exitAllPositions() {
      exits += 1
      return {
        submitted: [
          { instrumentUid: "u1", symbol: "F_XU0300826", quantity: 1, orderUid: "exit-1" },
          { instrumentUid: "u2", symbol: "F_THYAO0826", quantity: 2, orderUid: "exit-2" },
        ],
        failures: [],
      }
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    positionExit,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  mockInput.pressKey("x", { shift: true })
  expect(exits).toBe(0)
  await mockInput.typeText("x")
  await waitForFrame((frame) => frame.includes("Press x again to exit all open positions."))
  expect(exits).toBe(0)
  await mockInput.typeText("x")
  await waitForFrame((frame) => frame.includes("Submitted exit orders for 2 VIOP positions."))
  expect(exits).toBe(1)

  screen.destroy()
  renderer.destroy()
})

test("expires destructive-action confirmation after its timeout", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  let cancellations = 0
  const cancellation: ViopOrderCancellationSource = {
    async listPendingOrders() {
      cancellations += 1
      return []
    },
    async cancelPendingOrders() {
      return { cancelledOrderUids: [], failures: [] }
    },
  }
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    orderCancellation: cancellation,
    destructiveConfirmationTimeoutMs: 50,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  await mockInput.typeText("c")
  await waitForFrame((frame) => frame.includes("Press c again to cancel all pending orders."))
  await Bun.sleep(75)
  await waitForFrame((frame) => !frame.includes("Press c again to cancel all pending orders."))
  await mockInput.typeText("c")
  await waitForFrame((frame) => frame.includes("Press c again to cancel all pending orders."))
  expect(cancellations).toBe(0)

  screen.destroy()
  renderer.destroy()
})

test("opens the complete shortcut help with question mark and closes it again", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24 })
  const screen = new WatchlistScreen(renderer, { instruments, candles, news })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  await mockInput.typeText("?")
  const firstPage = await waitForFrame((frame) => frame.includes("Keyboard shortcuts"))
  expect(firstPage).toContain("Cancel all pending VIOP orders")
  expect(firstPage).toContain("Search and switch ticker")

  await mockInput.typeText("jjj")
  const contractPage = await waitForFrame((frame) => frame.includes("Sort by price change"))
  expect(contractPage).toContain("Sort by volume")

  await mockInput.typeText("jjjjjjjjjjjjj")
  const lastPage = await waitForFrame((frame) => frame.includes("Order ticket"))
  expect(lastPage).toContain("Next field, review, or submit")
  expect(lastPage).toContain("Review or submit the matching side")

  await mockInput.typeText("?")
  await waitForFrame((frame) => !frame.includes("Keyboard shortcuts") && frame.includes("XU030 stock"))

  screen.destroy()
  renderer.destroy()
})

test("opens the ChatGPT provider modal with capital A", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chatGptAccount: ChatGptAccount = {
    async getState() {
      return null
    },
    async connect() {
      throw new Error("not used")
    },
    async disconnect() {},
  }
  const screen = new WatchlistScreen(renderer, { instruments, candles, news, chatGptAccount })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  mockInput.pressKey("a", { shift: true })
  await waitForFrame((frame) => frame.includes("AI provider") && frame.includes("Not connected"))
  mockInput.pressEscape()
  await waitForFrame((frame) => !frame.includes("AI provider") && frame.includes("XU030 stock"))

  screen.destroy()
  renderer.destroy()
})

test("searches tickers with slash and switches only after Enter", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const preferences: WatchlistPreferences[] = []
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    onPreferencesChange: (value) => preferences.push(value),
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Chart  XU030 stock"))

  await mockInput.typeText("/thy")
  const searchFrame = await waitForFrame((frame) => frame.includes("/thy") && frame.includes("THYAO · F_THYAO0826"))
  expect(searchFrame).toContain("Chart  XU030 stock")

  mockInput.pressEnter()
  const selectedFrame = await waitForFrame((frame) => frame.includes("Chart  THYAO stock") && frame.includes("/ ticker"))
  expect(selectedFrame).not.toContain("/thy")
  expect(preferences.at(-1)?.selectedInstrumentUid).toBe("u2")

  await mockInput.typeText("/xu")
  await waitForFrame((frame) => frame.includes("XU030 · F_XU0300826"))
  mockInput.pressEscape()
  await waitForFrame((frame) => frame.includes("Chart  THYAO stock") && frame.includes("/ ticker"))

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
    chartTarget: string
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
      chartTarget: "UNDERLYING",
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

  await mockInput.typeText("f")
  await waitForFrame((frame) => frame.includes("Chart  THYAO futures"))
  expect(changes.at(-1)).toMatchObject({ chartTarget: "INSTRUMENT" })

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
      chartTarget: "UNDERLYING",
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

test("notifies onSessionExpired when device relogin fails", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 80, height: 20 })
  let expired = false
  const failing: ViopInstrumentSource = {
    async listInstruments() {
      throw new AuthenticationError("Device relogin failed")
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

  const readerLines = captureCharFrame().split("\n")
  const readerY = readerLines.findIndex((line) => line.includes("Full body text."))
  await mockMouse.doubleClick(x, readerY)
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

  focusPanel(mockInput, "news")
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
    (value) => value.includes("102,00") && value.includes("5Y") && value.includes("5m") && /[⠁-⣿]/.test(value),
  )
  expect(frame).not.toContain("Chart needs more room")
  expect(frame).toMatch(/[⠁-⣿]/)

  focusPanel(mockInput, "news")
  const newsFrame = await waitForFrame((value) => value.includes("BIST 30 güne"))
  expect(newsFrame).toContain("News")

  screen.destroy()
  renderer.destroy()
})

test("routes stock, futures, and index streams to the selected chart asset", async () => {
  const { renderer, mockInput, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({ width: 120, height: 24 })
  const equityQuotes = new FakeEquityQuoteStream()
  const quotes = new FakeQuoteStream()
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
    quotes,
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

  mockInput.pressTab()
  await mockInput.typeText("f")
  await waitForFrame((frame) => frame.includes("THYAO futures"))
  quotes.emitConnection(true)
  quotes.emit({ symbol: "F_THYAO0826", lastPrice: 120, sessionStatus: "OPEN", timestamp: 1_786_084_800_000 })
  const futuresFrame = await waitForFrame(
    (frame) => frame.includes("THYAO futures") && frame.includes("H 120,00") && frame.includes("● live"),
  )
  expect(futuresFrame).toContain("H 120,00")

  equityQuotes.emit("THYAO", 130, 1_786_084_900_000)
  await renderOnce()
  expect(captureCharFrame()).not.toContain("C 130,00")

  await mockInput.typeText("f")
  await waitForFrame((frame) => frame.includes("XU100 index"))
  expect(equityQuotes.startedSymbols.at(-1)).toBe("XU100")
  equityQuotes.emitConnection(true)
  equityQuotes.emit("XU100", 11_250, 1_786_084_900_000)
  await waitForFrame(
    (frame) => frame.includes("XU100 index") && frame.includes("11.250,00") && frame.includes("● live"),
  )

  await mockInput.typeText("f")
  await waitForFrame((frame) => frame.includes("XU030 index"))
  expect(equityQuotes.startedSymbols.at(-1)).toBe("XU030")
  equityQuotes.emitConnection(true)
  equityQuotes.emit("XU030", 12_800, 1_786_085_000_000)
  await waitForFrame(
    (frame) => frame.includes("XU030 index") && frame.includes("12.800,00") && frame.includes("● live"),
  )

  screen.destroy()
  expect(quotes.stopped).toBeTrue()
  expect(equityQuotes.stopped).toBeTrue()
  renderer.destroy()
})

class FakeDepthStream implements DepthStream {
  private listener: DepthBookListener | null = null
  private statusListener: DepthStatusListener | null = null
  startedSymbols: string[] = []
  stopped = false

  subscribe(listener: DepthBookListener): void {
    this.listener = listener
  }
  onStatusChange(listener: DepthStatusListener): void {
    this.statusListener = listener
  }
  start(symbol: string): void {
    this.startedSymbols.push(symbol)
  }
  stop(): void {
    this.stopped = true
  }
  emitStatus(status: DepthStatus): void {
    this.statusListener?.(status)
  }
  emit(book: DepthBook): void {
    this.listener?.(book)
  }
}

function depthBook(symbol: string): DepthBook {
  return {
    symbol,
    bids: [{ price: 389.75, lots: 38_384, orderCount: 26 }],
    asks: [{ price: 390, lots: 28_352, orderCount: 51 }],
    buyLots: 1_425_521,
    sellLots: 2_166_667,
    trades: [{ id: "1", price: 390, lots: 111, side: "BUY", buyer: "Gedik Yatırım", seller: "Ak Yatırım" }],
    marketClosed: false,
    maintenance: false,
    infoMessage: null,
  }
}

const entitledFeatures: MemberFeatureSource = {
  async loadFeatures() {
    return memberFeatureSet(["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION", "SETTLEMENT_ANALYSIS", "SUBSCRIPTION"])
  },
}

test("streams the underlying stock's order book beside the chart", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 200, height: 32 })
  const depth = new FakeDepthStream()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    depth,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()

  // The watchlist holds VIOP contracts, which have no book of their own, so the
  // panel follows the underlying stock.
  await waitFor(() => depth.startedSymbols.includes("XU030"))
  depth.emitStatus("live")
  depth.emit(depthBook("XU030"))
  const frame = await waitForFrame((value) => value.includes("Depth  XU030  ● live"))
  expect(frame).toContain("38.384  389,75│390,00")
  expect(frame).toContain("Gedik ← Ak")

  mockInput.pressArrow("down")
  await waitFor(() => depth.startedSymbols.includes("THYAO"))

  screen.destroy()
  expect(depth.stopped).toBeTrue()
  renderer.destroy()
})

test("keeps the book closed when the subscription does not include market depth", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 200, height: 32 })
  const depth = new FakeDepthStream()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    depth,
    memberFeatures: { async loadFeatures() { return memberFeatureSet(["SUBSCRIPTION"]) } },
  })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame((value) => value.includes("paid feature"))
  expect(frame).not.toContain("● live")
  // Without the entitlement the stream is never opened, so it cannot 403.
  expect(depth.startedSymbols).toEqual([])

  screen.destroy()
  renderer.destroy()
})

class FakeBrokerageSource implements BrokerageDistributionSource {
  requests: BrokerageDistributionRequest[] = []

  constructor(private readonly shares = 8) {}

  async loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    this.requests.push(request)
    return {
      side: request.side,
      shares: Array.from({ length: this.shares }, (_, index) => ({
        brokerage: `${request.side === "BUYER" ? "Buyer" : "Seller"} ${index + 1} Yatırım`,
        netLots: 900_000 - index * 100_000,
        averagePrice: 386 + index,
        percentage: 30 - index * 2,
      })),
      topCount: 5,
      topPercentage: 88.5,
      topLots: 2_100_000,
      otherLots: 300_000,
      lastUpdate: "Son Güncelleme: 13 Ağustos 15:37",
      live: true,
      presets: [
        { range: { start: null, end: null }, isDefault: true },
        { range: { start: "2026-08-07", end: "2026-08-13" }, isDefault: false },
      ],
      availableDates: ["2026-08-13", "2026-08-12"],
    }
  }
}

test("ranks broker buyers and sellers under the order book", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    brokerage,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame((value) => value.includes("Buyer 1"))
  expect(frame).toContain("Top 5 88,5%")
  expect(frame).toContain("Today")
  // The distribution belongs to the contract's own uid; the source resolves the underlying.
  expect(brokerage.requests[0]).toMatchObject({ instrumentUid: "u1", side: "BUYER", range: { start: null, end: null } })

  focusPanel(mockInput, "brokers")
  mockInput.pressArrow("right")
  await waitFor(() => brokerage.requests.some((request) => request.side === "SELLER"))
  await waitForFrame((value) => value.includes("Seller 1"))

  screen.destroy()
  renderer.destroy()
})

test("changes the broker date range through the popup", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    brokerage,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((value) => value.includes("Buyer 1"))

  focusPanel(mockInput, "brokers")
  await mockInput.typeText("d")
  await waitForFrame((value) => value.includes("Broker date range"))

  mockInput.pressArrow("down")
  mockInput.pressEnter()
  await waitFor(() => brokerage.requests.some((request) => request.range.start === "2026-08-07"))
  const frame = await waitForFrame((value) => value.includes("Last 7 days") && !value.includes("Broker date range"))
  expect(frame).toContain("Buyer 1")

  screen.destroy()
  renderer.destroy()
})

test("keeps the broker table closed without the entitlement", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    brokerage,
    memberFeatures: { async loadFeatures() { return memberFeatureSet(["MARKET_DEPTH"]) } },
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((value) => value.includes("Broker distribution is a paid feature"))
  expect(brokerage.requests).toEqual([])

  screen.destroy()
  renderer.destroy()
})

class FakeSettlementSource implements SettlementSource {
  requests: SettlementRequest[] = []

  async loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis> {
    this.requests.push(request)
    return {
      mode: request.mode,
      holdings: Array.from({ length: 6 }, (_, index) => ({
        brokerage: `Holder ${index + 1} Yatırım`,
        percentage: 30 - index * 2,
        percentageChange: request.mode === "HELD" ? null : 1.5 + index,
        lotChange: request.mode === "HELD" ? null : 900_000 - index * 50_000,
        totalLot: request.mode === "HELD" ? 496_359_440 - index * 1_000_000 : null,
      })),
      topCount: 5,
      topPercentage: 70.1,
      topLots: 826_142_663,
      otherLots: 352_458_757,
      lastUpdate: "Son Güncelleme: 13 Ağustos 18:00",
      live: false,
      presets: [
        { range: { start: null, end: null }, isDefault: true },
        { range: { start: "2026-08-07", end: "2026-08-13" }, isDefault: false },
      ],
      availableDates: ["2026-08-13", "2026-08-12"],
      unavailableMessage: null,
    }
  }
}

test("reads the settlement register from the broker panel's own tabs", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const settlement = new FakeSettlementSource()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    brokerage,
    settlement,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((value) => value.includes("Buyer 1"))

  // Buyers, sellers, then the register: three tabs along from the first.
  focusPanel(mockInput, "brokers")
  mockInput.pressArrow("right")
  mockInput.pressArrow("right")
  await waitFor(() => settlement.requests.length > 0)
  const frame = await waitForFrame((value) => value.includes("Holder 1"))

  expect(settlement.requests[0]).toMatchObject({
    instrumentUid: "u1",
    mode: "HELD",
    range: { start: null, end: null },
  })
  expect(frame).toContain("496.359.440")
  expect(frame).toContain("Total lot")

  mockInput.pressArrow("right")
  await waitFor(() => settlement.requests.some((request) => request.mode === "GAINED"))
  expect(await waitForFrame((value) => value.includes("+900.000"))).toContain("Δ lot")

  screen.destroy()
  renderer.destroy()
})

test("locks the settlement tabs on their own entitlement", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const settlement = new FakeSettlementSource()
  const screen = new WatchlistScreen(renderer, {
    instruments,
    candles,
    news,
    brokerage,
    settlement,
    memberFeatures: {
      async loadFeatures() { return memberFeatureSet(["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION"]) },
    },
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((value) => value.includes("Buyer 1"))

  focusPanel(mockInput, "brokers")
  mockInput.pressArrow("right")
  mockInput.pressArrow("right")
  await waitForFrame((value) => value.includes("Settlement analysis is a paid feature"))
  expect(settlement.requests).toEqual([])

  screen.destroy()
  renderer.destroy()
})
