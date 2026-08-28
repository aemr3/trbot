import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type KeyEvent, type Renderable, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type {
  BrokerageDistribution,
  BrokerageDistributionRequest,
  BrokerageDistributionSource,
} from "@trbot/market/brokerage.ts"
import type { SettlementAnalysis, SettlementRequest, SettlementSource } from "@trbot/market/settlement.ts"
import { DEFAULT_INTERVALS_BY_RANGE, type CandleSource } from "@trbot/market/candle.ts"
import { ApplicationLog } from "../logging/application-log.ts"
import type {
  DepthBook,
  DepthBookListener,
  DepthStatus,
  DepthStatusListener,
  DepthStream,
} from "@trbot/market/depth.ts"
import { memberFeatureSet, type MemberFeatureSource } from "@trbot/member/features.ts"
import type {
  EquityQuoteListener,
  EquityQuoteStream,
} from "@trbot/market/equity-quote-stream.ts"
import type { ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { NewsSource } from "@trbot/market/news.ts"
import type { QuoteStream, QuoteUpdate, QuoteUpdateListener } from "@trbot/market/quote-stream.ts"
import type {
  AccountLiveUpdate,
  AccountLiveUpdateListener,
  AccountSource,
  AccountStream,
} from "@trbot/trading/account.ts"
import type {
  ExitViopPositionRequest,
  PlaceViopOrderRequest,
  ViopOrderCancellationSource,
  ViopOrderSource,
  ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { createStopRule, type StopRule, type StopRuleDraft, type StopRuleStatus } from "@trbot/trading/stop.ts"
import { createPriceAlert, type PriceAlert, type PriceAlertDraft, type PriceAlertStatus } from "@trbot/market/alert.ts"
import type { StopRuleView, StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"
import { RemoteAlerts, RemoteStopRules } from "../remote-monitors.ts"
import { LogsScreen } from "./logs.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"
import { TradeScreen, type TradeChatPanel } from "./trade.ts"
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from "@trbot/preferences/app.ts"

// Tab cycles the panels in this order from a freshly mounted screen. Naming the
// destination keeps the tests readable, and adding a panel only moves this list.
const FOCUS_ORDER = ["instruments", "portfolio", "chart", "depth", "brokers", "account", "news"] as const

function focusPanel(mockInput: { pressTab(): void }, panel: (typeof FOCUS_ORDER)[number]): void {
  for (let step = 0; step < FOCUS_ORDER.indexOf(panel); step++) mockInput.pressTab()
}

class FakeTradeChatPanel implements TradeChatPanel {
  readonly root: BoxRenderable
  readonly composerTarget: BoxRenderable
  readonly transcriptText: TextRenderable
  readonly keys: KeyEvent[] = []
  activations = 0
  deactivations = 0
  mounted = false
  destroyed = false
  modalHost: BoxRenderable | null = null
  openedQuestions: string[] = []
  openedPermissions: string[] = []
  openedSessions: string[] = []
  undoOpenCount = 0
  interruptCount = 0
  selectedSessionId = "side-session"

  constructor(renderer: RenderContext) {
    this.root = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, flexDirection: "column" })
    const transcriptTarget = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, focusable: true })
    this.transcriptText = new TextRenderable(renderer, { content: "SIDE CHAT" })
    transcriptTarget.add(this.transcriptText)
    this.composerTarget = new BoxRenderable(renderer, { width: "100%", height: 1, focusable: true })
    this.root.add(transcriptTarget)
    this.root.add(this.composerTarget)
  }

  mount(): void {
    this.mounted = true
  }
  setModalHost(host: BoxRenderable): void {
    this.modalHost = host
  }
  hasOpenModal(): boolean {
    return false
  }
  activate(): void {
    this.activations += 1
    this.composerTarget.focus()
  }
  deactivate(): void {
    this.deactivations += 1
    this.composerTarget.blur()
  }
  clearInputOnInterrupt(): boolean {
    this.interruptCount += 1
    return true
  }
  canReleaseFocus(): boolean {
    return true
  }
  openUndo(): void {
    this.undoOpenCount += 1
  }
  handleKey(key: KeyEvent): void {
    this.keys.push(key)
  }
  openQuestion(sessionId: string): void {
    this.openedQuestions.push(sessionId)
    this.selectedSessionId = sessionId
  }
  openPermission(sessionId: string): void {
    this.openedPermissions.push(sessionId)
    this.selectedSessionId = sessionId
  }
  openSession(sessionId: string): void {
    this.openedSessions.push(sessionId)
    this.selectedSessionId = sessionId
  }
  isShowingSession(sessionId: string): boolean {
    return sessionId === this.selectedSessionId
  }
  setMarketOpen(): void {}
  destroy(): void {
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }
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
  async loadAccount(options) {
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
      performance: {
        range: options?.portfolioRange ?? "WEEK",
        points: [
          { date: "2026-08-13", profitLoss: -1_200, profitLossPercent: -1.2, totalCollateral: 120_000 },
          { date: "2026-08-14", profitLoss: 3_400, profitLossPercent: 2.8, totalCollateral: 123_400 },
        ],
        profitLoss: 5_000,
        profitLossPercent: 4.17,
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
  const { renderer, renderOnce, waitForFrame, captureCharFrame, mockMouse } = await createTestRenderer({
    width: 120,
    height: 30,
  })

  const screen = new TradeScreen(renderer, { instruments, candles, news })
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

  const lines = frame.split("\n")
  const sortY = lines.findIndex((line) => line.includes("Volume ↓"))
  await mockMouse.click(lines[sortY]?.indexOf("Volume") ?? -1, sortY)
  expect(renderer.getSelection()).toBeNull()

  screen.destroy()
  renderer.destroy()
})

test("aligns prices and changes for the longer XAUTRY contract symbol", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const mixedSymbolLengths: ViopInstrumentSource = {
    async listInstruments() {
      return [
        { uid: "stock", symbol: "F_TRMET0826", displayName: "TRMET", underlyingSymbol: "TRMET", lastPrice: 143.5, changePercent: 7.54, volume: 200, currency: "TRY" },
        { uid: "gold", symbol: "F_XAUTRYM0826", displayName: "XAUTRY", underlyingSymbol: "XAUTRY", lastPrice: 7_137.8, changePercent: 1.4, volume: 100, currency: "TRY" },
      ]
    },
  }
  const screen = new TradeScreen(renderer, { instruments: mixedSymbolLengths, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame((value) => value.includes("F_XAUTRYM0826") && value.includes("7.137,80"))
  const stockRow = frame.split("\n").find((line) => line.includes("F_TRMET0826"))
  const goldRow = frame.split("\n").find((line) => line.includes("F_XAUTRYM0826"))

  expect(stockRow).toBeDefined()
  expect(goldRow).toBeDefined()
  const stockPriceEnd = (stockRow?.indexOf("143,50") ?? -1) + "143,50".length
  const goldPriceEnd = (goldRow?.indexOf("7.137,80") ?? -1) + "7.137,80".length
  expect(stockPriceEnd).toBe(goldPriceEnd)
  expect(stockRow?.indexOf("+7.54%")).toBe(goldRow?.indexOf("+1.40%"))

  screen.destroy()
  renderer.destroy()
})

test("switches between selected-stock and index news feeds", async () => {
  const { renderer, mockInput, mockMouse, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
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
  const screen = new TradeScreen(renderer, { instruments, candles, news: scopedNews })
  renderer.root.add(screen.root)
  screen.mount()

  const stockFrame = await waitForFrame((frame) => frame.includes("Selected stock announces results"))
  const stockLines = stockFrame.split("\n")
  expect(stockLines.some((line) => line.includes("News   Chat"))).toBe(true)
  expect(stockLines.some((line) => line.includes("Feed   Stock   Indices"))).toBe(true)
  expect(stockLines.some((line) => line.includes("News") && line.includes("Stock"))).toBe(false)
  expect(requests.at(-1)).toBe("u1")

  const feedY = stockLines.findIndex((line) => line.includes("Feed") && line.includes("Indices"))
  await mockMouse.click(stockLines[feedY]?.indexOf("Indices") ?? -1, feedY)
  await waitForFrame((frame) => frame.includes("BIST 100 closes higher"))
  expect(requests.at(-1)).toBeNull()
  expect(renderer.getSelection()).toBeNull()

  mockInput.pressArrow("left")
  await waitForFrame((frame) => frame.includes("Selected stock announces results"))
  expect(requests.at(-1)).toBe("u1")

  screen.destroy()
  renderer.destroy()
})

test("switches the news panel to its embedded chat and releases input for ticker search", async () => {
  const { renderer, mockInput, mockMouse, waitForFrame } = await createTestRenderer({
    width: 120,
    height: 30,
    kittyKeyboard: true,
  })
  const chat = new FakeTradeChatPanel(renderer)
  const preferenceChanges: AppPreferences[] = []
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    chat,
    onPreferencesChange: (preferences) => preferenceChanges.push(preferences),
  })
  renderer.root.add(screen.root)
  screen.mount()
  const newsToolbarFrame = await waitForFrame((frame) => frame.includes("BIST 30 güne yükselişle başladı"))

  const newsToolbarLines = newsToolbarFrame.split("\n")
  const rightViewY = newsToolbarLines.findIndex((line) => line.includes("News") && line.includes("Chat"))
  await mockMouse.click(newsToolbarLines[rightViewY]?.indexOf("Chat") ?? -1, rightViewY)
  const chatFrame = await waitForFrame((frame) => frame.includes("SIDE CHAT"))
  expect(renderer.getSelection()).toBeNull()
  await mockInput.typeText("hello")

  const chatLines = chatFrame.split("\n")
  const toolbarLine = chatLines.findIndex((line) => line.includes("News") && line.includes("Chat"))
  const contentLine = chatLines.findIndex((line) => line.includes("SIDE CHAT"))
  expect(contentLine - toolbarLine).toBe(1)
  expect(chatFrame).not.toContain("BIST 30 güne yükselişle başladı")
  expect(chat.mounted).toBe(true)
  expect(chat.modalHost).toBe(screen.root)
  expect(chat.activations).toBeGreaterThan(0)
  expect(chat.keys.map((key) => key.sequence).join("")).toBe("hello")
  expect(screen.selectContract("F_THYAO0826", { focusInstrument: false })).toBe(true)
  await mockInput.typeText("!")
  expect(chat.keys.map((key) => key.sequence).join("")).toBe("hello!")
  expect(screen.clearInputOnInterrupt()).toBe(true)
  expect(chat.interruptCount).toBe(1)
  expect(screen.isShowingSession("side-session")).toBe(true)
  expect(screen.hasEmbeddedChat()).toBe(true)
  expect(preferenceChanges.at(-1)?.selectedTradeRightView).toBe("chat")

  const tickerLine = chatFrame.split("\n").findIndex((line) => line.includes("▶ F_XU0300826"))
  const tickerColumn = chatFrame.split("\n")[tickerLine]?.indexOf("F_XU0300826") ?? -1
  expect(tickerLine).toBeGreaterThanOrEqual(0)
  expect(tickerColumn).toBeGreaterThanOrEqual(0)
  await mockMouse.click(tickerColumn, tickerLine)
  await mockInput.typeText("/")
  await waitForFrame((frame) => frame.includes("Ticker search"))
  expect(chat.keys.map((key) => key.sequence).join("")).toBe("hello!")

  await mockInput.typeText("thy")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("▶ F_THYAO0826") && !frame.includes("Ticker search"))

  mockInput.pressKey("c", { meta: true })
  mockInput.pressEscape()
  await mockInput.typeText("/")
  await waitForFrame((frame) => frame.includes("Ticker search"))
  expect(chat.keys.map((key) => key.sequence).join("")).toBe("hello!")
  mockInput.pressEscape()

  const restoredChat = await waitForFrame((frame) => frame.includes("SIDE CHAT") && !frame.includes("Ticker search"))
  const sideChatLine = restoredChat.split("\n").findIndex((line) => line.includes("SIDE CHAT"))
  const sideChatColumn = restoredChat.split("\n")[sideChatLine]?.indexOf("SIDE CHAT") ?? -1
  expect(sideChatLine).toBeGreaterThanOrEqual(0)
  expect(sideChatColumn).toBeGreaterThanOrEqual(0)
  await mockMouse.click(sideChatColumn, sideChatLine)
  expect(renderer.currentFocusedRenderable).toBe(chat.composerTarget)
  await mockInput.typeText("/")
  expect(chat.keys.map((key) => key.sequence).join("")).toBe("hello!/")
  const focusedChat = await waitForFrame((frame) => frame.includes("SIDE CHAT"))
  expect(focusedChat).not.toContain("Ticker search")

  mockInput.pressEscape()
  mockInput.pressEscape()
  expect(chat.undoOpenCount).toBe(1)

  const activationsBeforeNotification = chat.activations
  screen.openSession("another-session")
  expect(chat.openedSessions).toEqual(["another-session"])
  expect(screen.isShowingSession("another-session")).toBe(true)
  expect(chat.activations).toBeGreaterThan(activationsBeforeNotification)

  mockInput.pressKey("n", { meta: true })
  const newsFrame = await waitForFrame((frame) => frame.includes("BIST 30 güne yükselişle başladı"))
  expect(newsFrame).not.toContain("SIDE CHAT")
  expect(screen.isShowingSession("another-session")).toBe(false)
  expect(screen.hasEmbeddedChat()).toBe(true)
  expect(screen.clearInputOnInterrupt()).toBe(false)
  expect(chat.interruptCount).toBe(1)
  expect(preferenceChanges.at(-1)?.selectedTradeRightView).toBe("news")

  screen.openSession("notification-session")
  const reopenedChatFrame = await waitForFrame((frame) => frame.includes("SIDE CHAT"))
  expect(chat.openedSessions).toEqual(["another-session", "notification-session"])
  expect(screen.isShowingSession("notification-session")).toBe(true)

  const reopenedLines = reopenedChatFrame.split("\n")
  const transcriptLine = reopenedLines.findIndex((line) => line.includes("SIDE CHAT"))
  const transcriptColumn = reopenedLines[transcriptLine]?.indexOf("SIDE CHAT") ?? -1
  expect(transcriptLine).toBeGreaterThanOrEqual(0)
  expect(transcriptColumn).toBeGreaterThanOrEqual(0)
  await mockMouse.drag(transcriptColumn + "SIDE CHAT".length - 1, transcriptLine, 0, transcriptLine)
  const selection = renderer.getSelection()
  expect(selection?.selectedRenderables).toContain(chat.transcriptText)
  expect(selection?.selectedRenderables.every((renderable) => isDescendantOf(renderable, chat.root))).toBe(true)

  screen.destroy()
  expect(chat.destroyed).toBe(true)
  renderer.destroy()
})

function isDescendantOf(renderable: Renderable, ancestor: Renderable): boolean {
  let current: Renderable | null = renderable
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

test("restores the embedded chat as the selected trade-side view", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const chat = new FakeTradeChatPanel(renderer)
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    chat,
    preferences: { ...DEFAULT_APP_PREFERENCES, selectedTradeRightView: "chat" },
  })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame((output) => output.includes("SIDE CHAT"))
  expect(frame).not.toContain("BIST 30 güne yükselişle başladı")
  expect(screen.isShowingSession("side-session")).toBe(true)

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
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    logs,
    manageInput: false,
  })
  const logScreen = new LogsScreen(renderer, { logs, onClose: () => workspace?.selectTab("trade") })
  workspace = new TradingWorkspaceScreen(renderer, {
    trade: screen,
    chat: idlePanel(renderer),
    logs: logScreen,
  })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  mockInput.pressKey("3", { meta: true })
  const logFrame = await waitForFrame((frame) => frame.includes("APPLICATION LOGS") && frame.includes("Unknown parameter"))
  expect(logFrame).toContain("Market data")
  expect(logFrame).toContain("statusCode")
  mockInput.pressKey("1", { meta: true })
  await waitForFrame((frame) => frame.includes("XU030 stock") && !frame.includes("APPLICATION LOGS"))

  workspace.destroy()
  renderer.destroy()
})

test("opens modal buy and sell tickets and submits simulated market orders at exchange limits", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 160, height: 30, kittyKeyboard: true })
  const placed: PlaceViopOrderRequest[] = []
  const screen = new TradeScreen(renderer, {
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

test("shows the account's figures beside the contract, and the rest in tabs", async () => {
  const { renderer, mockInput, mockMouse, waitForFrame } = await createTestRenderer({ width: 160, height: 30 })
  const screen = new TradeScreen(renderer, { instruments, candles, news, account })
  renderer.root.add(screen.root)
  screen.mount()

  // The portfolio is not a tab: it has a panel of its own under the list.
  const portfolioFrame = await waitForFrame((frame) => frame.includes("Available") && frame.includes("₺125.000,00"))
  expect(portfolioFrame).toContain("Collateral")
  expect(portfolioFrame).toContain("  Positions    Orders    Stops    Alerts")

  focusPanel(mockInput, "account")
  // Positions lead: they are what the other three tabs are all about.
  const positionsFrame = await waitForFrame((frame) => frame.includes("300,00→312,00"))
  expect(positionsFrame).toContain("+₺240,00")

  const lines = positionsFrame.split("\n")
  const positionY = lines.findIndex((line) => line.includes("300,00→312,00"))
  const positionX = lines[positionY]?.indexOf("THYAO") ?? -1
  expect(positionX).toBeGreaterThanOrEqual(0)
  await mockMouse.click(positionX, positionY)
  await waitForFrame((frame) => frame.includes("Chart  THYAO stock") && frame.includes("▶ F_THYAO0826"))

  mockInput.pressArrow("right")
  const ordersFrame = await waitForFrame((frame) => frame.includes("THYAO alış"))
  expect(ordersFrame).toContain("PENDING")

  screen.destroy()
  renderer.destroy()
})

test("reloads the account for the portfolio range the panel asks for", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 160, height: 40 })
  const ranges: Array<string | undefined> = []
  const rangedAccount: AccountSource = {
    async loadAccount(options) {
      ranges.push(options?.portfolioRange)
      return account.loadAccount(options)
    },
  }
  const screen = new TradeScreen(renderer, { instruments, candles, news, account: rangedAccount })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Week P/L"))
  expect(ranges).toEqual(["WEEK"])

  focusPanel(mockInput, "portfolio")
  mockInput.pressArrow("right")

  // One call serves both the summary and the bars, so changing the range is a
  // reload rather than a second request.
  await waitFor(() => ranges.includes("MONTH"))
  await waitForFrame((frame) => frame.includes("Month P/L"))

  screen.destroy()
  renderer.destroy()
})

test("walks panel focus backwards with Shift+Tab", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 160, height: 40 })
  const ranges: Array<string | undefined> = []
  const rangedAccount: AccountSource = {
    async loadAccount(options) {
      ranges.push(options?.portfolioRange)
      return account.loadAccount(options)
    },
  }
  const screen = new TradeScreen(renderer, { instruments, candles, news, account: rangedAccount })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Week P/L"))

  // Two tabs forward reach the chart, so one back belongs to the portfolio;
  // its range keys are what proves where the focus landed.
  focusPanel(mockInput, "chart")
  mockInput.pressTab({ shift: true })
  mockInput.pressArrow("right")
  await waitFor(() => ranges.includes("MONTH"))
  await waitForFrame((frame) => frame.includes("Month P/L"))

  screen.destroy()
  renderer.destroy()
})

test("applies live account, order, and futures price updates", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 160, height: 30 })
  const quotes = new FakeQuoteStream()
  const accountStream = new FakeAccountStream()
  const screen = new TradeScreen(renderer, { instruments, candles, news, account, accountStream, quotes })
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
  // Orders sit one tab right of the positions the panel opens on.
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

  mockInput.pressArrow("left")
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

  const screen = new TradeScreen(renderer, { instruments, candles, news, quotes })
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

  const screen = new TradeScreen(renderer, { instruments, candles, news, quotes })
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

test("dims its footer on a closed session and restores it when trading opens", async () => {
  const { renderer, renderOnce, waitForFrame, captureSpans } = await createTestRenderer({ width: 120, height: 30 })
  const quotes = new FakeQuoteStream()
  const marketStates: boolean[] = []
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    quotes,
    now: () => new Date("2026-08-20T12:00:00+03:00"),
    onMarketOpenChange: (open) => marketStates.push(open),
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("THYAO"))

  quotes.emit({ symbol: "F_XU0300826", lastPrice: 15_910, sessionStatus: "CLOSED", timestamp: 1 })
  await renderOnce()
  const closedFooter = captureSpans().lines.at(-1)?.spans.map((span) => span.bg.toInts()) ?? []
  expect(closedFooter).toContainEqual([41, 38, 56, 255])

  quotes.emit({ symbol: "F_XU0300826", lastPrice: 15_911, sessionStatus: "OPEN", timestamp: 2 })
  await renderOnce()
  const openFooter = captureSpans().lines.at(-1)?.spans.map((span) => span.bg.toInts()) ?? []
  expect(openFooter).toContainEqual([63, 47, 212, 255])
  expect(marketStates).toEqual([true, false, true])

  screen.destroy()
  renderer.destroy()
})

test("closes the chrome from Istanbul time when the session ends without another quote", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 120, height: 30 })
  let now = new Date("2026-08-20T18:09:00+03:00")
  const marketStates: boolean[] = []
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    now: () => now,
    marketClockIntervalMs: 5,
    onMarketOpenChange: (open) => marketStates.push(open),
  })
  renderer.root.add(screen.root)
  screen.mount()
  expect(marketStates).toEqual([true])

  now = new Date("2026-08-20T18:10:00+03:00")
  await waitFor(() => marketStates.at(-1) === false)
  expect(marketStates).toEqual([true, false])

  screen.destroy()
  renderer.destroy()
})

test("keeps the chrome dim during the evening when stock futures are closed", async () => {
  const { renderer } = await createTestRenderer({ width: 120, height: 30 })
  const marketStates: boolean[] = []
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    now: () => new Date("2026-08-20T22:00:00+03:00"),
    onMarketOpenChange: (open) => marketStates.push(open),
  })
  renderer.root.add(screen.root)
  screen.mount()

  expect(marketStates).toEqual([false])

  screen.destroy()
  renderer.destroy()
})

test("shows contract symbols and sorts them while preserving the selected contract", async () => {
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
  const screen = new TradeScreen(renderer, { instruments: sortable, candles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const volumeFrame = await waitForFrame((frame) => frame.includes("Volume ↓") && frame.includes("AAA stock"))
  expect(viopRowSymbols(volumeFrame)).toEqual(["F_AAA0826", "F_BBB0826", "F_CCC0826"])
  expect(volumeFrame).toContain("AAA stock")

  await mockInput.typeText("c")
  await renderOnce()
  expect(captureCharFrame()).toContain("Volume ↓")

  await mockInput.typeText("%")
  const changeDescFrame = await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(changeDescFrame.indexOf("+3.00%")).toBeLessThan(changeDescFrame.indexOf("+1.00%"))
  expect(changeDescFrame.indexOf("+1.00%")).toBeLessThan(changeDescFrame.indexOf("-2.00%"))
  expect(changeDescFrame).toContain("AAA stock")
  expect(changeDescFrame).toMatch(/▶ F_AAA0826/)

  await mockInput.typeText("%")
  const changeAscFrame = await waitForFrame((frame) => frame.includes("Change ↑"))
  expect(changeAscFrame.indexOf("-2.00%")).toBeLessThan(changeAscFrame.indexOf("+1.00%"))
  expect(changeAscFrame.indexOf("+1.00%")).toBeLessThan(changeAscFrame.indexOf("+3.00%"))

  mockInput.pressKey("v", { shift: true })
  const volumeAgainFrame = await waitForFrame((frame) => frame.includes("Volume ↓"))
  expect(viopRowSymbols(volumeAgainFrame)).toEqual(["F_AAA0826", "F_BBB0826", "F_CCC0826"])

  // A list by ticker reads A to Z first, unlike the two figure sorts.
  mockInput.pressKey("n", { shift: true })
  const nameFrame = await waitForFrame((frame) => frame.includes("Name ↑"))
  expect(viopRowSymbols(nameFrame)).toEqual(["F_AAA0826", "F_BBB0826", "F_CCC0826"])

  mockInput.pressKey("n", { shift: true })
  const nameDescFrame = await waitForFrame((frame) => frame.includes("Name ↓"))
  expect(viopRowSymbols(nameDescFrame)).toEqual(["F_CCC0826", "F_BBB0826", "F_AAA0826"])

  expect(screen.selectContract("F_BBB0826")).toBe(true)
  await waitForFrame((frame) => frame.includes("▶ F_BBB0826"))
  expect(screen.selectContract("F_MISSING0826")).toBe(false)

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
  const screen = new TradeScreen(renderer, {
    instruments: refreshing,
    candles,
    news,
    instrumentIntervalMs: 10,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const initialFrame = await waitForFrame((frame) => frame.includes("AAA stock"))
  expect(viopRowSymbols(initialFrame)).toEqual(["F_AAA0826", "F_BBB0826", "F_CCC0826"])
  await waitFor(() => calls >= 2)
  const refreshedFrame = await waitForFrame(
    (frame) => viopRowSymbols(frame).join(",") === "F_CCC0826,F_BBB0826,F_AAA0826",
  )
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
  const screen = new TradeScreen(renderer, {
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

// Contract size and collateral only arrive with the contract detail call,
// which used to run on selection alone.
test("keeps what one lot costs fresh while the selection stays put", async () => {
  // Wide enough for the cost to sit beside the OHLC line, and under the width
  // at which the depth panel claims part of the chart column.
  const { renderer, waitFor, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 180, height: 24 })
  let collateral = 1_000
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
        initialCollateral: collateral,
        leverage: 3,
        contractSize: 100,
        expiryDate: "31/08/2026",
        sessionHigh: 112,
        sessionLow: 108,
        settlementPrice: null,
        previousSettlementPrice: 107.84,
        volume: 5_000,
        openInterest: 1_000,
      }
    },
  }
  const screen = new TradeScreen(renderer, {
    instruments: refreshingDetails,
    candles,
    news,
    instrumentIntervalMs: 10,
  })
  renderer.root.add(screen.root)
  screen.mount()

  // 110 a lot of 100 is ₺11.000 of exposure for ₺1.000 of collateral.
  await waitForFrame((frame) => frame.includes("1 lot ₺11.000,00") && frame.includes("margin ₺1.000,00"))

  collateral = 2_000
  await waitForFrame((frame) => frame.includes("margin ₺2.000,00"))

  // A failed background refresh keeps the last good figures on screen.
  failing = true
  const callsBeforeFailure = detailCalls
  await waitFor(() => detailCalls > callsBeforeFailure + 1)
  await renderOnce()
  expect(captureCharFrame()).toContain("margin ₺2.000,00")

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
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    orderCancellation: cancellation,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  await mockInput.typeText("%")
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
    async exitPosition(request) {
      return { instrumentUid: request.instrumentUid, symbol: "F_XU0300826", quantity: 1, orderUid: "exit-1" }
    },
  }
  const screen = new TradeScreen(renderer, {
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

/**
 * A bulk exit whose outcome is unknown is the one case the trader is most
 * likely to repeat, and repeating it must not send a second set of exits on top
 * of the first. The key names the exit, so a retry carries the same one and the
 * server deduplicates it; once an exit has actually been answered, pressing
 * again is a new exit over whatever is open now.
 */
test("retrying a bulk exit reuses its key, and a later one gets its own", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 24 })
  const keys: (string | undefined)[] = []
  let failNext = true
  const positionExit: ViopPositionExitSource = {
    async exitAllPositions(options) {
      keys.push(options?.idempotencyKey)
      if (failNext) {
        failNext = false
        throw new Error("the connection dropped")
      }
      return { submitted: [{ instrumentUid: "u1", symbol: "F_XU0300826", quantity: 1, orderUid: "exit-1" }], failures: [] }
    },
    async exitPosition(request) {
      return { instrumentUid: request.instrumentUid, symbol: "F_XU0300826", quantity: 1, orderUid: "exit-1" }
    },
  }
  const screen = new TradeScreen(renderer, { instruments, candles, news, account, positionExit })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("XU030 stock"))

  async function pressExitTwice(): Promise<void> {
    await mockInput.typeText("x")
    await waitForFrame((frame) => frame.includes("Press x again to exit all open positions."))
    await mockInput.typeText("x")
  }

  // The first attempt fails without saying whether it arrived.
  await pressExitTwice()
  await waitForFrame((frame) => frame.includes("Failed to exit positions"))

  // The trader presses again: this is the same exit, retried.
  await pressExitTwice()
  await waitForFrame((frame) => frame.includes("Submitted exit orders for 1 VIOP position."))

  expect(keys).toHaveLength(2)
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).toBe(keys[0])

  // That exit was answered, so the next one is a new exit rather than a retry.
  await pressExitTwice()
  await waitForFrame((frame) => frame.includes("Submitted exit orders for 1 VIOP position."))

  expect(keys).toHaveLength(3)
  expect(keys[2]).not.toBe(keys[0])

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
  const screen = new TradeScreen(renderer, {
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
  const screen = new TradeScreen(renderer, { instruments, candles, news })
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

  // Far enough to reach the bottom of the list however many sections it holds.
  await mockInput.typeText("j".repeat(40))
  const lastPage = await waitForFrame((frame) => frame.includes("Order ticket"))
  expect(lastPage).toContain("Next field, review, or submit")
  expect(lastPage).toContain("Review or submit the matching side")

  await mockInput.typeText("?")
  await waitForFrame((frame) => !frame.includes("Keyboard shortcuts") && frame.includes("XU030 stock"))

  screen.destroy()
  renderer.destroy()
})

test("searches tickers with slash and switches only after Enter", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const preferences: AppPreferences[] = []
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    onPreferencesChange: (value) => preferences.push(value),
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Chart  XU030 stock"))

  await mockInput.typeText("/thy")
  const searchFrame = await waitForFrame((frame) => frame.includes("Ticker search") && frame.includes("THYAO  F_THYAO0826"))
  expect(searchFrame).toContain("Chart  XU030 stock")

  mockInput.pressEnter()
  const selectedFrame = await waitForFrame((frame) => frame.includes("Chart  THYAO stock") && frame.includes("/ ticker"))
  expect(selectedFrame).not.toContain("Ticker search")
  expect(preferences.at(-1)?.selectedInstrumentUid).toBe("u2")

  await mockInput.typeText("/xu")
  await waitForFrame((frame) => frame.includes("Ticker search") && frame.includes("XU030  F_XU0300826"))
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
  const screen = new TradeScreen(renderer, {
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
      depthTarget: "UNDERLYING",
      chartIndicators: [],
      selectedInstrumentUid: "u1",
      orderKind: "LIMIT",
      selectedMainChatSessionId: null,
      selectedTradePanelChatSessionId: null,
      selectedTradeRightView: "news",
      showChatThoughts: true,
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

  await mockInput.typeText("%")
  await waitForFrame((frame) => frame.includes("Change ↓"))
  expect(changes.at(-1)).toMatchObject({ instrumentSort: "change", sortDirection: "desc" })

  focusPanel(mockInput, "chart")
  mockInput.pressArrow("right")
  await waitFor(() => changes.some((preferences) => preferences.candleRange === "MONTH"))
  // Range and timeframe are independent, so widening the window keeps the
  // restored grain instead of resetting it to whatever the range used to imply.
  expect(changes.at(-1)).toMatchObject({ candleRange: "MONTH", candleInterval: "MIN_15" })

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
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    preferences: {
      instrumentSort: "volume",
      sortDirection: "desc",
      candleRange: "INTRADAY",
      candleInterval: "MIN_5",
      chartTarget: "UNDERLYING",
      depthTarget: "UNDERLYING",
      chartIndicators: [],
      selectedInstrumentUid: "expired-contract",
      orderKind: "LIMIT",
      selectedMainChatSessionId: null,
      selectedTradePanelChatSessionId: null,
      selectedTradeRightView: "news",
      showChatThoughts: true,
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
    .map((line) => line.slice(0, 36).match(/^[ ▶]{3}(F_(?:AAA|BBB|CCC)0826)\s+\d/)?.[1])
    .filter((symbol): symbol is string => Boolean(symbol))
}

test("notifies onSessionExpired when device relogin fails", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 80, height: 20 })
  let expired = false
  const failing: ViopInstrumentSource = {
    async listInstruments() {
      throw new ProtocolError("unauthenticated", "Device relogin failed")
    },
  }

  const screen = new TradeScreen(renderer, {
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

  const screen = new TradeScreen(renderer, { instruments, candles, news })
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

  const screen = new TradeScreen(renderer, { instruments, candles, news })
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
  const { renderer, mockInput, mockMouse, waitForFrame, waitFor } = await createTestRenderer({ width: 120, height: 24 })
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
  const screen = new TradeScreen(renderer, { instruments, candles: trackingCandles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const chartFrame = await waitForFrame((frame) => frame.includes("XU030") && /[\u2801-\u28ff]/u.test(frame))
  await waitFor(() => requested.some((request) => request.range === "INTRADAY" && request.interval === "MIN_5"))
  const plotY = chartFrame.split("\n").findIndex((line) => /[\u2801-\u28ff]/u.test(line))
  const plotX = chartFrame.split("\n")[plotY]?.search(/[\u2801-\u28ff]/u) ?? -1
  expect(plotX).toBeGreaterThanOrEqual(0)
  expect(plotY).toBeGreaterThanOrEqual(0)
  await mockMouse.click(plotX, plotY)
  mockInput.pressArrow("right")
  // The range moves on its own; the timeframe stays as it was.
  await waitFor(() => requested.some((request) => request.range === "WEEK" && request.interval === "MIN_5"))
  mockInput.pressArrow("down")
  await waitFor(() => requested.some((request) => request.range === "WEEK" && request.interval === "MIN_15"))

  expect(requested).toContainEqual({ range: "WEEK", interval: "MIN_5" })
  expect(requested).toContainEqual({ range: "WEEK", interval: "MIN_15" })
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
  const screen = new TradeScreen(renderer, { instruments, candles: historyCandles, news })
  renderer.root.add(screen.root)
  screen.mount()

  const newestFrame = await waitForFrame((frame) => frame.includes("XU030 stock") && frame.includes("◀") && !frame.includes("history"))
  expect(newestFrame).toContain("█")
  focusPanel(mockInput, "chart")
  mockInput.pressArrow("left", { shift: true })
  await waitForFrame((frame) => frame.includes("history"))

  mockInput.pressArrow("right", { shift: true })
  await waitForFrame((frame) => !frame.includes("history"))

  screen.destroy()
  renderer.destroy()
})

test("keeps the chart usable in an 80-column terminal", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 80, height: 24 })
  const screen = new TradeScreen(renderer, { instruments, candles, news })
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
  const screen = new TradeScreen(renderer, {
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

  focusPanel(mockInput, "chart")
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
    trades: [{
      id: "1",
      price: 390,
      lots: 111,
      timestamp: Date.parse("2026-08-21T10:15:30Z"),
      side: "BUY",
      buyer: "Gedik Yatırım",
      seller: "Ak Yatırım",
    }],
    marketClosed: false,
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
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    depth,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()

  // Both books exist now, and the panel opens on the stock's.
  await waitFor(() => depth.startedSymbols.includes("XU030"))
  depth.emitStatus("live")
  depth.emit(depthBook("XU030"))
  const frame = await waitForFrame((value) => value.includes("Depth  ● live"))
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
  const screen = new TradeScreen(renderer, {
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
  failure: Error | null = null

  constructor(private readonly shares = 8) {}

  async loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    this.requests.push(request)
    if (this.failure) throw this.failure
    return {
      side: request.side,
      shares: Array.from({ length: this.shares }, (_, index) => ({
        brokerage: `${request.side === "BUYER" ? "Buyer" : "Seller"} ${index + 1} Yatırım`,
        netLots: 900_000 - index * 100_000,
        averagePrice: 386 + index,
        percentage: 30 - index * 2,
        grossLots: 3_000_000 - index * 200_000,
        volumeShare: 10 - index,
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

test("uses only the market-data views available for a futures-only underlying", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const candleTargets: Array<string | undefined> = []
  const futuresOnly: ViopInstrumentSource = {
    async listInstruments() {
      return [{
        uid: "gold-future",
        symbol: "F_XAUTRYM0826",
        displayName: "XAUTRY",
        underlyingSymbol: "XAUTRY",
        lastPrice: 7_156.7,
        changePercent: 0.8,
        volume: 100_000,
        currency: "TRY",
        marketData: {
          instrumentCandles: true,
          underlyingSymbol: null,
          underlyingKind: null,
          brokerAnalytics: false,
        },
      }]
    },
  }
  const availableCandles: CandleSource = {
    async loadCandles(instrumentUid, range, interval, options) {
      candleTargets.push(options?.target)
      return candles.loadCandles(instrumentUid, range, interval, options)
    },
  }
  const screen = new TradeScreen(renderer, {
    instruments: futuresOnly,
    candles: availableCandles,
    news,
    brokerage,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const frame = await waitForFrame(
    (value) => value.includes("Chart  XAUTRY futures") && value.includes("cash-equity underlying"),
  )
  expect(frame).not.toContain("Failed to load")
  expect(candleTargets[0]).toBe("INSTRUMENT")
  expect(brokerage.requests).toEqual([])

  screen.destroy()
  renderer.destroy()
})

test("reloads failed HTTP panels when the server stream reconnects", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const quotes = new FakeQuoteStream()
  const brokerage = new FakeBrokerageSource()
  let candleRequests = 0
  let candlesUnavailable = false
  const reconnectingCandles: CandleSource = {
    async loadCandles(instrumentUid, range, interval, options) {
      candleRequests += 1
      if (candlesUnavailable) throw new Error("Cannot reach the trbot server")
      return candles.loadCandles(instrumentUid, range, interval, options)
    },
  }
  const screen = new TradeScreen(renderer, {
    instruments,
    candles: reconnectingCandles,
    news,
    quotes,
    brokerage,
    memberFeatures: entitledFeatures,
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("Buyer 1") && frame.includes("XU030"))
  quotes.emitConnection(true)
  await waitForFrame((frame) => frame.includes("● live"))

  quotes.emitConnection(false)
  candlesUnavailable = true
  brokerage.failure = new Error("Cannot reach the trbot server")
  focusPanel(mockInput, "chart")
  mockInput.pressArrow("right")
  mockInput.pressTab()
  mockInput.pressTab()
  mockInput.pressArrow("right")
  await waitForFrame((frame) => frame.includes("Failed to load candles") && frame.includes("Failed to load:"))

  const failedCandleRequests = candleRequests
  const failedBrokerRequests = brokerage.requests.length
  candlesUnavailable = false
  brokerage.failure = null
  quotes.emitConnection(true)

  const recovered = await waitForFrame(
    (frame) => frame.includes("Seller 1") && !frame.includes("Failed to load candles") && !frame.includes("Failed to load:"),
  )
  expect(recovered).toContain("● live")
  expect(candleRequests).toBeGreaterThan(failedCandleRequests)
  expect(brokerage.requests.length).toBeGreaterThan(failedBrokerRequests)

  screen.destroy()
  renderer.destroy()
})

test("ranks broker buyers and sellers under the order book", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({ width: 200, height: 44 })
  const brokerage = new FakeBrokerageSource()
  const screen = new TradeScreen(renderer, {
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
  const screen = new TradeScreen(renderer, {
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
  const screen = new TradeScreen(renderer, {
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
  const screen = new TradeScreen(renderer, {
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
  const screen = new TradeScreen(renderer, {
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

// A rule protecting the fixture's long THYAO position, 305 under a 312 market.
function stopRuleFixture(): StopRule {
  return createStopRule(
    {
      id: "rule-1",
      instrumentUid: "position-1",
      symbol: "F_THYAO0826",
      displayName: "THYAO",
      side: "LONG",
      role: "STOP",
      kind: "PRICE",
      value: 305,
      basis: "TOUCH",
      interval: null,
      quantity: null,
      referencePrice: 300,
      atrValue: null,
    },
    1_786_000_000_000,
  )
}

/**
 * Stands in for the server's rule editing. The real one sends a draft and gets
 * back the rule the server built, which is what these record.
 */
class FakeStopRules {
  readonly rules = new Map<string, StopRule>()
  readonly savedDrafts: StopRuleDraft[] = []

  constructor(
    seed: StopRule[] = [],
    /** Records what the terminal asked the server to do about a fired rule. */
    readonly decisions: string[] = [],
  ) {
    for (const rule of seed) this.rules.set(rule.id, rule)
  }

  async list(): Promise<StopRule[]> {
    return [...this.rules.values()]
  }
  async save(draft: StopRuleDraft): Promise<StopRule> {
    this.savedDrafts.push(draft)
    const rule = createStopRule(draft, Date.now())
    this.rules.set(rule.id, rule)
    return rule
  }
  async remove(id: string): Promise<void> {
    this.rules.delete(id)
  }
  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    const rule = this.rules.get(id)
    if (rule) this.rules.set(id, { ...rule, status })
  }
  /** Set to make a decision fail, as an unreachable server would. */
  decideFailure: Error | null = null
  async decide(id: string, decision: string): Promise<void> {
    this.decisions.push(`stop:${id}:${decision}`)
    if (this.decideFailure) throw this.decideFailure
  }
}

function fakePositionExit(exits: ExitViopPositionRequest[]): ViopPositionExitSource {
  return {
    async exitAllPositions() {
      return { submitted: [], failures: [] }
    },
    async exitPosition(request) {
      exits.push(request)
      return {
        instrumentUid: request.instrumentUid,
        symbol: "F_THYAO0826",
        quantity: request.quantity ?? 2,
        orderUid: "exit-1",
      }
    },
  }
}
function priceAlertFixture(): PriceAlert {
  return createPriceAlert(
    {
      id: "alert-1",
      instrumentUid: "u2",
      symbol: "F_THYAO0826",
      displayName: "THYAO",
      direction: "BELOW",
      kind: "PRICE",
      value: 305,
      basis: "TOUCH",
      interval: null,
      repeat: "ONCE",
      referencePrice: 312,
      atrValue: null,
    },
    1_786_000_000_000,
  )
}

class FakeAlerts {
  readonly alerts = new Map<string, PriceAlert>()
  readonly savedDrafts: PriceAlertDraft[] = []

  constructor(seed: PriceAlert[] = []) {
    for (const alert of seed) this.alerts.set(alert.id, alert)
  }

  async list(): Promise<PriceAlert[]> {
    return [...this.alerts.values()]
  }
  async save(draft: PriceAlertDraft): Promise<PriceAlert> {
    this.savedDrafts.push(draft)
    const alert = createPriceAlert(draft, Date.now())
    this.alerts.set(alert.id, alert)
    return alert
  }
  async remove(id: string): Promise<void> {
    this.alerts.delete(id)
  }
  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    const alert = this.alerts.get(id)
    if (alert) this.alerts.set(id, { ...alert, status })
  }
}

function stopView(rule: StopRule): StopRuleView {
  return { rule, level: 305, lastPrice: 310, distancePercent: -1.6, feed: "live", hasPosition: true }
}


function stopTrigger(rule: StopRule): StopTriggerEvent {
  return {
    rule,
    position: {
      uid: "position-1",
      symbol: "F_THYAO0826",
      displayName: "F_THYAO0826",
      quantity: 2,
      averageCost: 310,
      currentPrice: 304,
      unrealizedProfitLoss: null,
      currency: "TRY",
    },
    price: 304,
    quantity: 2,
    side: "SELL",
    priceAgeMs: 0,
  }
}

/** Records what the terminal asks the server to do about a fired rule. */
function fakeMonitorClient(decisions: string[]) {
  return {
    decideAlert: (alertId: string, decision: string) => decisions.push(`alert:${alertId}:${decision}`),
  }
}

test("subscribes to the contracts the server's stop rules protect, not only the watchlist", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 120, height: 30 })
  const quotes = new FakeQuoteStream()
  const rule = { ...stopRuleFixture(), symbol: "F_UNWATCHED0826" }
  const stops = new RemoteStopRules(new FakeStopRules([rule], []))
  const screen = new TradeScreen(renderer, { instruments, candles, news, account, quotes, stops })
  renderer.root.add(screen.root)
  screen.mount()

  stops.acceptViews([stopView(rule)])

  await waitFor(() => quotes.startedSymbols?.includes("F_UNWATCHED0826") === true)
  expect(quotes.startedSymbols).toContain("F_XU0300826")

  screen.destroy()
  renderer.destroy()
})

test("a stop the server reports as fired asks first and never exits locally", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const exits: ExitViopPositionRequest[] = []
  const decisions: string[] = []
  const rule = stopRuleFixture()
  const stops = new RemoteStopRules(new FakeStopRules([rule], decisions))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    positionExit: fakePositionExit(exits),
    stops,
    stopCountdownMs: 60_000,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))

  stops.acceptTrigger(stopTrigger(rule), 60_000, false)

  const modal = await waitForFrame((frame) => frame.includes("Stop reached"))
  expect(modal).toContain("SELL 2 at the exchange limit")
  // The exit belongs to the server: the terminal must not send one itself.
  expect(exits).toHaveLength(0)

  screen.destroy()
  renderer.destroy()
})

test("confirming a fired stop asks the server to send it", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const exits: ExitViopPositionRequest[] = []
  const decisions: string[] = []
  const rule = stopRuleFixture()
  const stops = new RemoteStopRules(new FakeStopRules([rule], decisions))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    positionExit: fakePositionExit(exits),
    stops,
    stopCountdownMs: 60_000,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))
  stops.acceptTrigger(stopTrigger(rule), 60_000, false)
  await waitForFrame((frame) => frame.includes("Stop reached"))

  mockInput.pressEnter()

  expect(decisions).toEqual(["stop:rule-1:confirm"])
  expect(exits).toHaveLength(0)

  screen.destroy()
  renderer.destroy()
})

test("cancelling a fired stop stands it down through the server", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const exits: ExitViopPositionRequest[] = []
  const decisions: string[] = []
  const rule = stopRuleFixture()
  const stops = new RemoteStopRules(new FakeStopRules([rule], decisions))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    positionExit: fakePositionExit(exits),
    stops,
    stopCountdownMs: 60_000,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))
  stops.acceptTrigger(stopTrigger(rule), 60_000, false)
  await waitForFrame((frame) => frame.includes("Stop reached"))

  mockInput.pressEscape()
  // Escape is disambiguated from an escape sequence, so the decision lands once
  // the modal has actually gone.
  await waitForFrame((frame) => !frame.includes("Stop reached"))

  expect(decisions).toEqual(["stop:rule-1:cancel"])
  expect(exits).toHaveLength(0)

  screen.destroy()
  renderer.destroy()
})

test("an alert the server reports as fired rings and trades nothing", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const exits: ExitViopPositionRequest[] = []
  const cues: string[] = []
  const alert = priceAlertFixture()
  const alerts = new RemoteAlerts(new FakeAlerts([alert]), fakeMonitorClient([]))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    positionExit: fakePositionExit(exits),
    alerts,
    sound: { play: (cue) => cues.push(cue) },
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))

  alerts.acceptTrigger({ alert, price: 304, priceAgeMs: 0 })

  await waitForFrame((value) => value.includes("Nothing was traded"))
  expect(cues).toEqual(["ALERT"])
  expect(exits).toEqual([])

  mockInput.pressKey("escape")
  await waitForFrame((value) => !value.includes("Nothing was traded"))
  expect(exits).toEqual([])

  screen.destroy()
  renderer.destroy()
})

/**
 * The server holds a fired alert as outstanding until a client answers it, and
 * replays what is outstanding to whoever attaches. Closing only the popup leaves
 * it outstanding, so the next reconnect — or the next terminal — rings again for
 * an alert the trader already dealt with.
 */
test("dismissing an alert tells the server, so it stops being replayed", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const decisions: string[] = []
  const alert = priceAlertFixture()
  const alerts = new RemoteAlerts(new FakeAlerts([alert]), fakeMonitorClient(decisions))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    alerts,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))

  alerts.acceptTrigger({ alert, price: 304, priceAgeMs: 0 })
  await waitForFrame((frame) => frame.includes("Nothing was traded"))

  mockInput.pressKey("escape")
  await waitForFrame((frame) => !frame.includes("Nothing was traded"))

  expect(decisions).toEqual([`alert:${alert.id}:dismiss`])

  screen.destroy()
  renderer.destroy()
})

/**
 * The countdown belongs to the server. Saying "no order sent" without being
 * told so is the worst thing this screen can do: the trader stops watching, and
 * the exit goes out anyway when the countdown runs out.
 */
test("does not claim a stop was stood down until the server says it was", async () => {
  const { renderer, mockInput, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })
  const rule = stopRuleFixture()
  const rules = new FakeStopRules([rule])
  rules.decideFailure = new ProtocolError("upstream_unavailable", "Cannot reach the trbot server")
  const stops = new RemoteStopRules(rules)
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    stops,
    stopCountdownMs: 60_000,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))
  stops.acceptTrigger(stopTrigger(rule), 60_000, false)
  await waitForFrame((frame) => frame.includes("Stop reached"))

  mockInput.pressEscape()
  await waitForFrame((frame) => frame.includes("Could not stand down"))

  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).not.toContain("no order sent")
  // And it says the countdown is still going, which is the actionable part.
  expect(frame).toContain("countdown is still running")

  screen.destroy()
  renderer.destroy()
})

test("the rules a fired stop shows come from the server, not local evaluation", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 120, height: 30 })
  const rule = stopRuleFixture()
  const stops = new RemoteStopRules(new FakeStopRules([rule], []))
  const screen = new TradeScreen(renderer, {
    instruments,
    candles,
    news,
    account,
    quotes: new FakeQuoteStream(),
    stops,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Collateral"))

  expect(stops.views()).toEqual([])
  stops.acceptViews([stopView(rule)])
  expect(stops.views()).toHaveLength(1)
  expect(stops.symbols()).toEqual(["F_THYAO0826"])

  screen.destroy()
  renderer.destroy()
})

/**
 * A stand-in for the AI tab, which this file is not testing. The workspace mounts
 * every panel, so it needs something there.
 */
interface IdlePanel {
  root: BoxRenderable
  handleKey(): void
  destroy(): void
}

function idlePanel(renderer: RenderContext): IdlePanel {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%" })
  return {
    root,
    handleKey: () => {},
    destroy: () => {
      if (!root.isDestroyed) root.destroyRecursively()
    },
  }
}
