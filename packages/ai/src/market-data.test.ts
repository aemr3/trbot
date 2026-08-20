import { expect, test } from "bun:test"
import { FUTURES_INTERVALS_BY_RANGE, type CandleSeries } from "@trbot/market/candle.ts"
import type { DepthBook, DepthBookListener, DepthStatusListener, DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteListener, EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { memberFeatureSet } from "@trbot/member/features.ts"
import { marketDataTools, type MarketDataSources, type MarketDataToolClients } from "./market-data.ts"
import { ChatTools } from "./tool.ts"

const NOW = 1_786_000_000_000
const ASELS: ViopInstrument = {
  uid: "instrument-1",
  symbol: "F_ASELS0826",
  displayName: "ASELS",
  underlyingSymbol: "ASELS",
  lastPrice: 400,
  changePercent: 1.5,
  volume: 12_000,
  currency: "TRY",
}
const THYAO: ViopInstrument = {
  ...ASELS,
  uid: "instrument-2",
  symbol: "F_THYAO0826",
  displayName: "THYAO",
  underlyingSymbol: "THYAO",
  lastPrice: 300,
}

class FakeDepthStream implements DepthStream {
  listener: DepthBookListener | null = null
  statusListener: DepthStatusListener | null = null
  stopped = 0
  started: string[] = []

  constructor(private readonly book: DepthBook | null) {}
  subscribe(listener: DepthBookListener): void { this.listener = listener }
  onStatusChange(listener: DepthStatusListener): void { this.statusListener = listener }
  start(symbol: string): void {
    this.started.push(symbol)
    if (this.book) this.listener?.(this.book)
    else this.statusListener?.("unavailable")
  }
  stop(): void { this.stopped += 1 }
}

class FakeEquityQuoteStream implements EquityQuoteStream {
  listener: EquityQuoteListener | null = null
  stopped = 0

  subscribe(listener: EquityQuoteListener): void { this.listener = listener }
  onConnectionChange(): void {}
  start(symbol: string): void {
    this.listener?.({ symbol, lastPrice: 80, timestamp: NOW, sessionStatus: "OPEN" })
  }
  stop(): void { this.stopped += 1 }
}

class UnavailableEquityQuoteStream implements EquityQuoteStream {
  stopped = 0

  subscribe(): void {}
  onConnectionChange(): void {}
  start(): void { throw new Error("Equity market is unavailable") }
  stop(): void { this.stopped += 1 }
}

function harness(patch: Partial<MarketDataSources> = {}) {
  const depth = new FakeDepthStream(depthBook())
  const equity = new FakeEquityQuoteStream()
  const calls = {
    brokerage: [] as unknown[],
    settlement: [] as unknown[],
    candles: [] as Array<{ instrumentUid: string; target: string | undefined }>,
  }
  const sources: MarketDataSources = {
    instruments: {
      listInstruments: async () => [ASELS, THYAO],
      loadContractDetails: async () => ({
        initialCollateral: 30,
        leverage: 8,
        contractSize: 100,
        expiryDate: "2026-08-31",
        sessionHigh: 410,
        sessionLow: 390,
        settlementPrice: 399,
        previousSettlementPrice: 395,
        volume: 10_000,
        openInterest: 20_000,
      }),
    },
    candles: {
      loadCandles: async (uid, range, interval, options) => {
        calls.candles.push({ instrumentUid: uid, target: options?.target })
        return candles(uid, range, interval)
      },
    },
    account: {
      loadAccount: async (_options) => ({
        portfolio: {
          currency: "TRY",
          totalCollateral: 100_000,
          availableCollateral: 80_000,
          dailyProfitLoss: 1_000,
          dailyProfitLossPercent: 1,
          periodProfitLoss: 5_000,
          periodProfitLossPercent: 5,
        },
        performance: { range: "WEEK", points: [], profitLoss: 5_000, profitLossPercent: 5 },
        orders: [],
        positions: [{
          uid: ASELS.uid,
          symbol: ASELS.symbol,
          displayName: ASELS.displayName,
          quantity: 2,
          averageCost: 390,
          currentPrice: 400,
          unrealizedProfitLoss: 2_000,
          currency: "TRY",
        }],
        updatedAt: NOW,
      }),
    },
    orders: {
      prepareOrder: async () => ({
        lowerLimit: 360,
        upperLimit: 440,
        lastPrice: 401,
        ask: 402,
        bid: 400,
        priceScale: 1,
        contractSize: 100,
        initialCollateral: 30,
        availableCollateral: 80_000,
        currentPositionQuantity: 2,
        positionIntent: "BUY_TO_OPEN",
      }),
      listPendingOrders: async () => [{ uid: "order-1", title: "Buy ASELS", description: "2 @ 399" }],
    },
    brokerage: {
      loadDistribution: async (request) => {
        calls.brokerage.push(request)
        return {
          side: request.side,
          shares: Array.from({ length: 4 }, (_, index) => ({
            brokerage: `Broker ${index + 1}`,
            netLots: 100 - index,
            averagePrice: 400,
            percentage: 25,
          })),
          topCount: 3,
          topPercentage: 75,
          topLots: 300,
          otherLots: 100,
          lastUpdate: "2026-08-19",
          live: true,
          presets: [],
          availableDates: ["2026-08-19"],
        }
      },
    },
    settlement: {
      loadSettlement: async (request) => {
        calls.settlement.push(request)
        return {
          mode: request.mode,
          holdings: Array.from({ length: 4 }, (_, index) => ({
            brokerage: `Broker ${index + 1}`,
            percentage: 25,
            percentageChange: 1,
            lotChange: 10,
            totalLot: 100,
          })),
          topCount: 3,
          topPercentage: 75,
          topLots: 300,
          otherLots: 100,
          lastUpdate: "2026-08-19",
          live: false,
          presets: [],
          availableDates: ["2026-08-18"],
          unavailableMessage: null,
        }
      },
    },
    news: {
      listNews: async () => [{
        uid: "news-1",
        tag: "Company",
        headline: "ASELS wins contract",
        body: "Full body",
        publishedAt: NOW,
        url: "https://example.com/news-1",
        attachments: [],
      }],
      getArticle: async () => ({
        uid: "news-1",
        tag: "Company",
        headline: "ASELS wins contract",
        body: "Full body",
        publishedAt: NOW,
        url: "https://example.com/news-1",
        attachments: ["https://example.com/report.pdf"],
      }),
    },
    memberFeatures: { loadFeatures: async () => memberFeatureSet(["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION"]) },
    openDepthStream: () => depth,
    openEquityQuoteStream: () => equity,
    ...patch,
  }
  const clients: MarketDataToolClients = {
    sources: () => sources,
    stops: { list: async () => [] },
  }
  return { clients, calls, depth, equity }
}

test("offers the complete read-only market toolset", () => {
  const names = marketDataTools(harness().clients).map((tool) => tool.definition.name)
  expect(names).toEqual([
    "list_instruments",
    "get_viop_quote",
    "get_contract_details",
    "get_candles",
    "get_account",
    "get_order_book",
    "get_equity_quote",
    "get_brokerage_distribution",
    "get_settlement",
    "list_news",
    "get_news_article",
    "list_pending_orders",
    "get_data_entitlements",
    "list_stop_rules",
  ])
})

test("searches instruments and reads current quote and contract details", async () => {
  const tools = new ChatTools(marketDataTools(harness().clients))
  const listed = await call(tools, "list_instruments", { query: "asel", limit: 1 })
  const quote = await call(tools, "get_viop_quote", { symbol: "ASELS" })
  const details = await call(tools, "get_contract_details", { symbol: "F_ASELS0826" })

  expect(modelData(listed)).toMatchObject({ matched: 1, instruments: [{ uid: ASELS.uid }] })
  expect(modelData(quote)).toMatchObject({ quote: { lastPrice: 401, lastPriceSource: "CONTRACT_QUOTE", bid: 400, ask: 402 } })
  expect(modelData(details)).toMatchObject({ details: { leverage: 8, openInterest: 20_000 } })
})

test("optionally sorts instruments before limiting them and keeps missing values last", async () => {
  const instruments: ViopInstrument[] = [
    { ...THYAO, changePercent: -4, volume: null },
    { ...ASELS, changePercent: null, volume: 100 },
    {
      ...ASELS,
      uid: "instrument-3",
      symbol: "F_KCHOL0826",
      displayName: "KCHOL",
      underlyingSymbol: "KCHOL",
      changePercent: 2,
      volume: 500,
    },
  ]
  const tools = new ChatTools(marketDataTools(harness({
    instruments: { listInstruments: async () => instruments },
  }).clients))

  const unchanged = await call(tools, "list_instruments", { limit: 3 })
  const change = await call(tools, "list_instruments", {
    sortBy: "CHANGE_PERCENT",
    sortDirection: "DESC",
    limit: 2,
  })
  const magnitude = await call(tools, "list_instruments", {
    sortBy: "ABS_CHANGE_PERCENT",
    sortDirection: "ASC",
    limit: 3,
  })
  const volume = await call(tools, "list_instruments", {
    sortBy: "VOLUME",
    sortDirection: "ASC",
    limit: 3,
  })

  expect(instrumentSymbols(unchanged)).toEqual(["F_THYAO0826", "F_ASELS0826", "F_KCHOL0826"])
  expect(instrumentSymbols(change)).toEqual(["F_KCHOL0826", "F_THYAO0826"])
  expect(instrumentSymbols(magnitude)).toEqual(["F_KCHOL0826", "F_THYAO0826", "F_ASELS0826"])
  expect(instrumentSymbols(volume)).toEqual(["F_ASELS0826", "F_KCHOL0826", "F_THYAO0826"])
})

test("falls back to the latest contract candle when closed-market quote sources have no price", async () => {
  const instrument = { ...ASELS, lastPrice: null }
  const testHarness = harness({
    instruments: { listInstruments: async () => [instrument] },
    orders: {
      prepareOrder: async () => ({
        lowerLimit: 360,
        upperLimit: 440,
        lastPrice: null,
        ask: null,
        bid: null,
        priceScale: 1,
        contractSize: 100,
        initialCollateral: 30,
        availableCollateral: 80_000,
        currentPositionQuantity: 0,
        positionIntent: "BUY_TO_OPEN",
      }),
      listPendingOrders: async () => [],
    },
  })
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const quote = await call(tools, "get_viop_quote", { symbol: instrument.symbol })

  expect(modelData(quote)).toMatchObject({
    instrument: { symbol: instrument.symbol },
    quote: {
      lastPrice: 403,
      lastPriceSource: "CANDLE_CLOSE",
      lastPriceTimestamp: NOW + 3 * 60_000,
      candleInterval: "HOUR_1",
      bid: null,
      ask: null,
    },
  })
  expect(testHarness.calls.candles).toEqual([{ instrumentUid: instrument.uid, target: "INSTRUMENT" }])
})

test("returns every candle by default and optionally limits the result", async () => {
  const tools = new ChatTools(marketDataTools(harness().clients))
  const request = {
    symbol: "ASELS",
    range: "WEEK",
    interval: "HOUR_1",
    target: "UNDERLYING",
  } as const
  const complete = modelData(await call(tools, "get_candles", request)) as {
    totalCandles: number
    candles: Array<{ close: number }>
  }
  const limited = modelData(await call(tools, "get_candles", { ...request, limit: 2 })) as {
    totalCandles: number
    candles: Array<{ close: number }>
  }

  expect(complete.totalCandles).toBe(4)
  expect(complete.candles.map((candle) => candle.close)).toEqual([400, 401, 402, 403])
  expect(limited.totalCandles).toBe(4)
  expect(limited.candles.map((candle) => candle.close)).toEqual([402, 403])
})

test("reads BIST index candles without requiring an active VIOP contract", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const xu100 = modelData(await call(tools, "get_candles", {
    symbol: "XU100",
    range: "MONTH",
    interval: "DAY_1",
  }))
  const xu030 = modelData(await call(tools, "get_candles", {
    target: "BIST_30",
    range: "MONTH",
    interval: "DAY_1",
  }))

  expect(xu100).toMatchObject({ instrument: null, symbol: "XU100", target: "BIST_100", totalCandles: 4 })
  expect(xu030).toMatchObject({ instrument: null, symbol: "XU030", target: "BIST_30", totalCandles: 4 })
  expect(testHarness.calls.candles).toEqual([
    { instrumentUid: "XU100", target: "BIST_100" },
    { instrumentUid: "XU030", target: "BIST_30" },
  ])
})

test("reads account, pending orders, features, and stop rules without mutations", async () => {
  const tools = new ChatTools(marketDataTools(harness().clients))
  const account = await call(tools, "get_account", { range: "WEEK" })
  const orders = await call(tools, "list_pending_orders", {})
  const features = await call(tools, "get_data_entitlements", {})
  const stops = await call(tools, "list_stop_rules", {})

  expect(modelData(account)).toMatchObject({ positions: [{ symbol: ASELS.symbol, quantity: 2 }] })
  expect(modelData(orders)).toEqual({ orders: [{ uid: "order-1", title: "Buy ASELS", description: "2 @ 399" }] })
  expect(modelData(features)).toEqual({ enabled: ["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION"] })
  expect(modelData(stops)).toEqual({ rules: [] })
})

test("takes bounded live depth and underlying-equity snapshots and closes both streams", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const depth = await call(tools, "get_order_book", { symbol: "ASELS", levels: 1, trades: 1 })
  const equity = await call(tools, "get_equity_quote", { symbol: "ASELS" })

  expect(modelData(depth)).toMatchObject({ bids: [{ price: 400 }], asks: [{ price: 402 }], trades: [{ id: "trade-1" }] })
  expect(modelData(depth)).toMatchObject({ symbol: "ASELS", underlyingSymbol: "ASELS" })
  expect(modelData(equity)).toMatchObject({ symbol: "ASELS", lastPrice: 80, sessionStatus: "OPEN", source: "LIVE_TICK" })
  expect(testHarness.depth.started).toEqual(["ASELS"])
  expect(testHarness.depth.stopped).toBe(1)
  expect(testHarness.equity.stopped).toBe(1)
})

test("falls back to the latest underlying candle when a live equity quote is unavailable", async () => {
  const stream = new UnavailableEquityQuoteStream()
  const testHarness = harness({ openEquityQuoteStream: () => stream })
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const equity = await call(tools, "get_equity_quote", { symbol: ASELS.symbol })

  expect(modelData(equity)).toMatchObject({
    symbol: "ASELS",
    lastPrice: 403,
    timestamp: NOW + 3 * 60_000,
    sessionStatus: null,
    source: "CANDLE_CLOSE",
    candleRange: "WEEK",
    candleInterval: "MIN_10",
  })
  expect(testHarness.calls.candles).toEqual([{ instrumentUid: ASELS.uid, target: "UNDERLYING" }])
  expect(stream.stopped).toBe(1)
})

test("rejects a VIOP symbol instead of translating it for the cash-equity order book", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const depth = await call(tools, "get_order_book", { symbol: ASELS.symbol })

  expect(depth.isError).toBe(true)
  expect(depth.blocks[0]?.text).toContain("underlying equity symbol")
  expect(testHarness.depth.started).toEqual([])
})

test("reads bounded brokerage and settlement reports for the requested range", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const brokerage = await call(tools, "get_brokerage_distribution", {
    symbol: "ASELS",
    side: "BUYER",
    start: "2026-08-18",
    end: "2026-08-19",
    limit: 2,
  })
  const settlement = await call(tools, "get_settlement", {
    symbol: "ASELS",
    mode: "GAINED",
    start: "2026-08-18",
    limit: 1,
  })

  expect(modelData(brokerage)).toMatchObject({ totalShares: 4, shares: [{ brokerage: "Broker 1" }, { brokerage: "Broker 2" }] })
  expect(modelData(settlement)).toMatchObject({ totalHoldings: 4, holdings: [{ brokerage: "Broker 1" }] })
  expect(testHarness.calls.brokerage[0]).toMatchObject({ range: { start: "2026-08-18", end: "2026-08-19" } })
  expect(testHarness.calls.settlement[0]).toMatchObject({ range: { start: "2026-08-18", end: null } })
})

test("lists news without duplicating bodies and fetches an article separately", async () => {
  const tools = new ChatTools(marketDataTools(harness().clients))
  const list = await call(tools, "list_news", { symbol: "ASELS" })
  const article = await call(tools, "get_news_article", { uid: "news-1" })

  expect(JSON.stringify(modelData(list))).not.toContain("Full body")
  expect(modelData(article)).toMatchObject({ uid: "news-1", body: "Full body", bodyTruncated: false })
})

test("reports unavailable depth and invalid broker date ranges as tool errors", async () => {
  const unavailable = new FakeDepthStream(null)
  const testHarness = harness({ openDepthStream: () => unavailable })
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const depth = await call(tools, "get_order_book", { symbol: "ASELS" })
  const dates = await call(tools, "get_settlement", {
    symbol: "ASELS",
    mode: "HELD",
    start: "2026-08-19",
    end: "2026-08-18",
  })

  expect(depth.isError).toBe(true)
  expect(depth.blocks[0]?.text).toContain("unavailable")
  expect(unavailable.stopped).toBe(1)
  expect(dates.isError).toBe(true)
  expect(dates.blocks[0]?.text).toContain("cannot precede")
})

test("explains how to choose settlement dates before requesting lot changes", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const result = await call(tools, "get_settlement", { symbol: "ASELS", mode: "GAINED" })

  expect(result.isError).toBe(true)
  expect(result.blocks[0]?.text).toContain("requires start in YYYY-MM-DD format")
  expect(result.blocks[0]?.text).toContain("mode HELD")
  expect(testHarness.calls.settlement).toEqual([])
})

async function call(tools: ChatTools, name: string, args: Record<string, unknown>) {
  return tools.call({ type: "toolCall", id: `${name}-call`, name, arguments: args }, {})
}

function modelData(outcome: Awaited<ReturnType<typeof call>>): unknown {
  return JSON.parse(outcome.modelBlocks?.[0]?.text ?? "null") as unknown
}

function instrumentSymbols(outcome: Awaited<ReturnType<typeof call>>): string[] {
  const data = modelData(outcome) as { instruments: ViopInstrument[] }
  return data.instruments.map((instrument) => instrument.symbol)
}

function candles(
  instrumentUid: string,
  range: CandleSeries["range"],
  interval: CandleSeries["interval"],
): CandleSeries {
  return {
    instrumentUid,
    range,
    interval,
    candles: Array.from({ length: 4 }, (_, index) => ({
      timestamp: NOW + index * 60_000,
      open: 400 + index,
      high: 401 + index,
      low: 399 + index,
      close: 400 + index,
      volume: 1_000 + index,
    })),
    availableIntervalsByRange: FUTURES_INTERVALS_BY_RANGE,
    intervalMs: 60_000,
    currency: "TRY",
  }
}

function depthBook(): DepthBook {
  return {
    symbol: ASELS.underlyingSymbol!,
    bids: [
      { price: 400, lots: 10, orderCount: 2 },
      { price: 399, lots: 20, orderCount: 3 },
    ],
    asks: [
      { price: 402, lots: 12, orderCount: 2 },
      { price: 403, lots: 22, orderCount: 3 },
    ],
    buyLots: 100,
    sellLots: 120,
    trades: [
      { id: "trade-1", price: 401, lots: 2, side: "BUY", buyer: "A", seller: "B" },
      { id: "trade-2", price: 400, lots: 1, side: "SELL", buyer: "C", seller: "D" },
    ],
    marketClosed: false,
    maintenance: false,
    infoMessage: null,
  }
}
