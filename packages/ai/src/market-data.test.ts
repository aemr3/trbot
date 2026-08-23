import { expect, test } from "bun:test"
import type { ToolCall } from "@earendil-works/pi-ai"
import { DEFAULT_INTERVALS_BY_RANGE, type CandleSeries } from "@trbot/market/candle.ts"
import type { DepthBook, DepthBookListener, DepthStatusListener, DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteListener, EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import {
  DEFAULT_FINANCIAL_METRICS,
  FINANCIAL_METRICS,
  type RecentFinancial,
  type RecentFinancialRequest,
} from "@trbot/market/financials.ts"
import { ViopInstrumentSchema, type ViopInstrument } from "@trbot/market/instrument.ts"
import type { IndexImpactCode, IndexImpactSnapshot } from "@trbot/market/index-impact.ts"
import { memberFeatureSet } from "@trbot/member/features.ts"
import { marketDataTools, type MarketDataSources, type MarketDataToolClients } from "./market-data.ts"
import { ChatTools } from "./tool.ts"
import { z } from "zod"
import type { BrokerageDistributionRequest } from "@trbot/market/brokerage.ts"
import type { SettlementRequest } from "@trbot/market/settlement.ts"
import { StopRuleSchema, createStopRule } from "@trbot/trading/stop.ts"

const ModelDataSchema = z.json()
const CandleResultSchema = z.object({
  totalCandles: z.number(),
  candles: z.array(z.object({ close: z.number() })),
})
const InstrumentResultSchema = z.object({ instruments: z.array(ViopInstrumentSchema) })

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
const FINANCIALS: RecentFinancial[] = [
  {
    symbol: "ASELS",
    publishedAt: "2026-08-18T15:00:00Z",
    period: "2026/6",
    metrics: {
      LAST_PRICE: 400,
      DAILY_CHANGE_PERCENT: 1.5,
      MARKET_CAP: 500_000_000_000,
      NET_INCOME: 10_000_000_000,
      ANNUAL_NET_INCOME_CHANGE_PERCENT: 20,
      PRICE_TO_EARNINGS: 12,
      PRICE_TO_BOOK: 3,
      PEG: 1.2,
      NET_DEBT: 2_000_000_000,
    },
  },
  {
    symbol: "THYAO",
    publishedAt: "2026-08-19T15:00:00Z",
    period: "2026/6",
    metrics: {
      LAST_PRICE: 300,
      DAILY_CHANGE_PERCENT: -1,
      MARKET_CAP: 600_000_000_000,
      NET_INCOME: 20_000_000_000,
      ANNUAL_NET_INCOME_CHANGE_PERCENT: null,
      PRICE_TO_EARNINGS: 8,
      PRICE_TO_BOOK: 1.5,
      PEG: 0.8,
      NET_DEBT: 3_000_000_000,
    },
  },
]
const INDEX_IMPACT: IndexImpactSnapshot = {
  readAt: NOW,
  marketTimestamp: NOW - 1_000,
  weightsUpdatedAt: "2026-08-21",
  index: {
    code: "XU030",
    title: "BİST 30",
    lastPrice: 101,
    previousClose: 100,
    changePercent: 1,
    pointChange: 1,
  },
  breadth: { advancing: 1, unchanged: 1, declining: 1, unavailable: 1 },
  estimatedConstituentImpactPoints: -3,
  broadMarket: {
    code: "XUTUM",
    title: "BIST TUM",
    weightsUpdatedAt: "2026-08-21",
    lastPrice: 202,
    previousClose: 200,
    changePercent: 1,
    pointChange: 2,
    impactPoints: 1,
  },
  contributions: [
    {
      symbol: "POS",
      lastPrice: 105,
      previousClose: 100,
      changePercent: 5,
      volume: 1_000,
      weightPercent: 40,
      impactPoints: 5,
      broadMarketWeightPercent: 20,
      broadMarketImpactPoints: 3,
    },
    {
      symbol: "NEG",
      lastPrice: 96,
      previousClose: 100,
      changePercent: -4,
      volume: 2_000,
      weightPercent: 30,
      impactPoints: -8,
      broadMarketWeightPercent: 15,
      broadMarketImpactPoints: -2,
    },
    {
      symbol: "FLAT",
      lastPrice: 100,
      previousClose: 100,
      changePercent: 0,
      volume: 500,
      weightPercent: 20,
      impactPoints: 0,
      broadMarketWeightPercent: 10,
      broadMarketImpactPoints: 0,
    },
    {
      symbol: "MISS",
      lastPrice: null,
      previousClose: null,
      changePercent: null,
      volume: null,
      weightPercent: 10,
      impactPoints: null,
      broadMarketWeightPercent: 5,
      broadMarketImpactPoints: null,
    },
  ],
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

function harness(
  patch: Partial<MarketDataSources> = {},
  candleInstruments?: MarketDataToolClients["candleData"]["instruments"],
) {
  const depth = new FakeDepthStream(depthBook())
  const equity = new FakeEquityQuoteStream()
  interface MarketCalls {
    brokerage: BrokerageDistributionRequest[]
    settlement: SettlementRequest[]
    candles: Array<{ instrumentUid: string; target: string | undefined }>
    feedCandles: Array<{ symbol: string; target: string | undefined }>
    financials: RecentFinancialRequest[]
    indexImpact: IndexImpactCode[]
  }
  const calls: MarketCalls = {
    brokerage: [],
    settlement: [],
    candles: [],
    feedCandles: [],
    financials: [],
    indexImpact: [],
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
    financials: {
      listRecentFinancials: async (request = {}) => {
        calls.financials.push(request)
        const wanted = request.symbols ? new Set(request.symbols) : null
        const metrics = request.metrics ?? [...DEFAULT_FINANCIAL_METRICS]
        return {
          universe: "VIOP_EQUITIES",
          eligibleSymbols: ["ASELS", "THYAO"],
          metrics,
          financials: FINANCIALS
            .filter((row) => !wanted || wanted.has(row.symbol))
            .map((row) => ({
              ...row,
              metrics: Object.fromEntries(
                metrics.flatMap((metric) => metric in row.metrics ? [[metric, row.metrics[metric]]] : []),
              ),
            })),
        }
      },
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
            grossLots: 500 - index,
            volumeShare: 5,
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
    candleData: {
      instruments: candleInstruments ?? {
        resolveCandleInstrument: async (symbol, target) => {
          const wanted = symbol.trim().toUpperCase()
          const instrument = [ASELS, THYAO].find((candidate) =>
            candidate.symbol === wanted
            || candidate.displayName === wanted
            || candidate.underlyingSymbol === wanted
          )
          if (!instrument) throw new Error(`No active VIOP contract matches ${symbol}`)
          if (target === "UNDERLYING" && !instrument.underlyingSymbol) {
            throw new Error(`${instrument.displayName} has no underlying cash/spot candle instrument; use target INSTRUMENT`)
          }
          const candleSymbol = target === "INSTRUMENT" ? instrument.symbol : instrument.underlyingSymbol
          if (!candleSymbol) throw new Error(`No candle symbol resolved for ${instrument.displayName}`)
          return {
            candleSymbol,
            contractSymbol: instrument.symbol,
            underlyingSymbol: instrument.underlyingSymbol,
            displayName: instrument.displayName,
          }
        },
      },
      candles: {
        loadCandles: async (symbol, range, interval, options) => {
          calls.feedCandles.push({ symbol, target: options?.target })
          return candles(symbol, range, interval)
        },
      },
    },
    indexData: {
      loadIndexImpact: async (index) => {
        calls.indexImpact.push(index)
        return INDEX_IMPACT
      },
    },
    stops: { list: async () => [] },
  }
  return { clients, calls, depth, equity }
}

test("offers the complete read-only market toolset", () => {
  const names = marketDataTools(harness().clients).map((tool) => tool.definition.name)
  expect(names).toEqual([
    "list_instruments",
    "list_viop_equity_financials",
    "get_viop_quote",
    "get_contract_details",
    "get_candles",
    "get_index_impact",
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

test("reads, filters, sorts, and pages complete index-impact snapshots", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const ranked = await call(tools, "get_index_impact", {
    index: "BIST_30",
    limit: 2,
  })
  const negative = await call(tools, "get_index_impact", {
    index: "BIST_30",
    direction: "NEGATIVE",
    sortBy: "POINT_IMPACT",
    sortDirection: "ASC",
    offset: 0,
    limit: 1,
  })
  const unavailable = await call(tools, "get_index_impact", {
    index: "BIST_30",
    direction: "UNAVAILABLE",
  })

  expect(modelData(ranked)).toMatchObject({
    totalConstituents: 4,
    matchedConstituents: 4,
    returnedConstituents: 2,
    contributions: [{ symbol: "NEG" }, { symbol: "POS" }],
  })
  expect(modelData(negative)).toMatchObject({
    matchedConstituents: 1,
    contributions: [{ symbol: "NEG", impactPoints: -8 }],
  })
  expect(modelData(unavailable)).toMatchObject({
    matchedConstituents: 1,
    contributions: [{ symbol: "MISS", impactPoints: null }],
  })
  expect(testHarness.calls.indexImpact).toEqual(["XU030", "XU030", "XU030"])
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

test("rejects a guessed out-month instead of substituting the available front month", async () => {
  const tools = new ChatTools(marketDataTools(harness().clients))

  const result = await call(tools, "get_viop_quote", { symbol: "F_ASELS0926" })

  expect(result.isError).toBe(true)
  expect(result.blocks[0]?.text).toContain("Only nearest-expiry contracts are available")
  expect(result.blocks[0]?.text).toContain("underlying symbol")
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

test("lists scoped VİOP equity financials from either a contract or underlying symbol", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const contract = await call(tools, "list_viop_equity_financials", {
    symbols: ["F_THYAO0826"],
    period: "2026/6",
  })
  const ranked = await call(tools, "list_viop_equity_financials", {
    sortBy: "NET_INCOME",
    sortDirection: "ASC",
    limit: 1,
  })

  expect(modelData(contract)).toMatchObject({
    universe: "VIOP_EQUITIES",
    matched: 1,
    metrics: [...DEFAULT_FINANCIAL_METRICS],
    financials: [{ symbol: "THYAO", metrics: { MARKET_CAP: 600_000_000_000 } }],
  })
  expect(testHarness.calls.financials[0]).toMatchObject({
    period: "2026/6",
    symbols: ["THYAO"],
    metrics: [...DEFAULT_FINANCIAL_METRICS],
  })
  expect(modelData(ranked)).toMatchObject({
    matched: 2,
    financials: [{ symbol: "ASELS", metrics: { NET_INCOME: 10_000_000_000 } }],
  })
  expect(testHarness.calls.financials[1]?.metrics).toEqual([
    ...DEFAULT_FINANCIAL_METRICS,
    "NET_INCOME",
  ])
})

test("selects exact or complete signed-in financial metric sets", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const selected = await call(tools, "list_viop_equity_financials", {
    metrics: ["PEG", "NET_DEBT"],
    sortBy: "PEG",
    sortDirection: "ASC",
    limit: 1,
  })
  await call(tools, "list_viop_equity_financials", {
    includeAllMetrics: true,
    limit: 1,
  })
  const conflicting = await call(tools, "list_viop_equity_financials", {
    metrics: ["PEG"],
    includeAllMetrics: true,
  })

  expect(modelData(selected)).toMatchObject({
    metrics: ["PEG", "NET_DEBT"],
    financials: [{ symbol: "THYAO", metrics: { PEG: 0.8, NET_DEBT: 3_000_000_000 } }],
  })
  expect(testHarness.calls.financials[0]?.metrics).toEqual(["PEG", "NET_DEBT"])
  expect(testHarness.calls.financials[1]?.metrics).toEqual([...FINANCIAL_METRICS])
  expect(conflicting.isError).toBe(true)
  expect(conflicting.blocks[0]?.text).toContain("either metrics or includeAllMetrics")
  expect(testHarness.calls.financials).toHaveLength(2)
})

test("rejects market-data views the selected contract does not provide before calling the feed", async () => {
  const testHarness = harness(
    {
      instruments: {
        listInstruments: async () => [{
          ...ASELS,
          uid: "gold-future",
          symbol: "F_XAUTRYM0826",
          displayName: "XAUTRY",
          underlyingSymbol: "XAUTRY",
          marketData: {
            instrumentCandles: true,
            underlyingSymbol: null,
            underlyingKind: null,
            brokerAnalytics: false,
          },
        }],
      },
    },
    {
      resolveCandleInstrument: async () => {
        throw new Error("XAUTRY has no underlying cash/spot candle instrument; use target INSTRUMENT")
      },
    },
  )
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const candleResult = await call(tools, "get_candles", {
    symbol: "XAUTRY",
    range: "MONTH",
    interval: "DAY_1",
    target: "UNDERLYING",
  })
  const quoteResult = await call(tools, "get_equity_quote", { symbol: "XAUTRY" })
  const brokerResult = await call(tools, "get_brokerage_distribution", {
    symbol: "XAUTRY",
    side: "BUYER",
  })
  const inferredDepth = await call(tools, "get_order_book", { symbol: "XAUTRY" })
  const underlyingDepth = await call(tools, "get_order_book", {
    symbol: "F_XAUTRYM0826",
    target: "UNDERLYING",
  })

  expect(candleResult.isError).toBe(true)
  expect(candleResult.blocks[0]?.text).toContain("use target INSTRUMENT")
  expect(quoteResult.isError).toBe(true)
  expect(quoteResult.blocks[0]?.text).toContain("no cash-equity underlying")
  expect(brokerResult.isError).toBe(true)
  expect(brokerResult.blocks[0]?.text).toContain("no cash-equity underlying")
  expect(modelData(inferredDepth)).toMatchObject({
    symbol: "F_XAUTRYM0826",
    instrumentSymbol: "F_XAUTRYM0826",
    underlyingSymbol: null,
    target: "INSTRUMENT",
  })
  expect(underlyingDepth.isError).toBe(true)
  expect(underlyingDepth.blocks[0]?.text).toContain("use target INSTRUMENT")
  expect(testHarness.calls.candles).toEqual([])
  expect(testHarness.calls.feedCandles).toEqual([])
  expect(testHarness.calls.brokerage).toEqual([])
  expect(testHarness.depth.started).toEqual(["F_XAUTRYM0826"])
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
  const testHarness = harness({
    instruments: {
      listInstruments: async () => { throw new Error("brokerage instruments must not be read for candles") },
    },
  })
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const request = {
    symbol: "ASELS",
    range: "WEEK",
    interval: "HOUR_1",
    target: "UNDERLYING",
  } as const
  const complete = CandleResultSchema.parse(modelData(await call(tools, "get_candles", request)))
  const limited = CandleResultSchema.parse(modelData(await call(tools, "get_candles", { ...request, limit: 2 })))

  expect(complete.totalCandles).toBe(4)
  expect(complete.candles.map((candle) => candle.close)).toEqual([400, 401, 402, 403])
  expect(limited.totalCandles).toBe(4)
  expect(limited.candles.map((candle) => candle.close)).toEqual([402, 403])
  expect(testHarness.calls.feedCandles).toEqual([
    { symbol: "ASELS", target: "UNDERLYING" },
    { symbol: "ASELS", target: "UNDERLYING" },
  ])
  expect(testHarness.calls.candles).toEqual([])
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
  expect(testHarness.calls.feedCandles).toEqual([
    { symbol: "XU100", target: "BIST_100" },
    { symbol: "XU030", target: "BIST_30" },
  ])
})

test("reads account, pending orders, features, and stop rules without mutations", async () => {
  const testHarness = harness()
  const openRule = createStopRule({
    id: "rule-open",
    instrumentUid: ASELS.uid,
    symbol: ASELS.symbol,
    displayName: ASELS.displayName,
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 380,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 390,
    atrValue: null,
  }, NOW)
  const tools = new ChatTools(marketDataTools({
    ...testHarness.clients,
    stops: {
      list: async () => [openRule, { ...openRule, id: "rule-closed", status: "DONE" }],
    },
  }))
  const account = await call(tools, "get_account", { range: "WEEK" })
  const orders = await call(tools, "list_pending_orders", {})
  const features = await call(tools, "get_data_entitlements", {})
  const stops = await call(tools, "list_stop_rules", {})

  expect(modelData(account)).toMatchObject({ positions: [{ symbol: ASELS.symbol, quantity: 2 }] })
  expect(modelData(orders)).toEqual({ orders: [{ uid: "order-1", title: "Buy ASELS", description: "2 @ 399" }] })
  expect(modelData(features)).toEqual({ enabled: ["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION"] })
  expect(z.object({ rules: z.array(StopRuleSchema) }).parse(modelData(stops)).rules).toEqual([openRule])
})

test("takes bounded live depth and underlying-equity snapshots and closes both streams", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))
  const depth = await call(tools, "get_order_book", { symbol: "ASELS", levels: 1, trades: 1 })
  const equity = await call(tools, "get_equity_quote", { symbol: "ASELS" })

  expect(modelData(depth)).toMatchObject({ bids: [{ price: 400 }], asks: [{ price: 402 }], trades: [{ id: "trade-1" }] })
  expect(modelData(depth)).toMatchObject({
    symbol: "ASELS",
    instrumentSymbol: ASELS.symbol,
    underlyingSymbol: "ASELS",
    target: "UNDERLYING",
  })
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
    candleInterval: "MIN_5",
  })
  expect(testHarness.calls.candles).toEqual([{ instrumentUid: ASELS.uid, target: "UNDERLYING" }])
  expect(stream.stopped).toBe(1)
})

test("selects the contract or underlying order book from the symbol and explicit target", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketDataTools(testHarness.clients))

  const inferredContract = await call(tools, "get_order_book", { symbol: ASELS.symbol })
  const selectedUnderlying = await call(tools, "get_order_book", {
    symbol: ASELS.symbol,
    target: "UNDERLYING",
  })
  const selectedContract = await call(tools, "get_order_book", {
    symbol: "ASELS",
    target: "INSTRUMENT",
  })

  expect(modelData(inferredContract)).toMatchObject({ symbol: ASELS.symbol, target: "INSTRUMENT" })
  expect(modelData(selectedUnderlying)).toMatchObject({ symbol: "ASELS", target: "UNDERLYING" })
  expect(modelData(selectedContract)).toMatchObject({ symbol: ASELS.symbol, target: "INSTRUMENT" })
  expect(testHarness.depth.started).toEqual([ASELS.symbol, "ASELS", ASELS.symbol])
  expect(testHarness.depth.stopped).toBe(3)
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

  // Gross activity and volume share ride along with the net, so the model can
  // tell one-way accumulation from a house that traded both ways all day.
  expect(modelData(brokerage)).toMatchObject({
    totalShares: 4,
    shares: [
      { brokerage: "Broker 1", netLots: 100, grossLots: 500, volumeShare: 5 },
      { brokerage: "Broker 2" },
    ],
  })
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

async function call(tools: ChatTools, name: string, args: ToolCall["arguments"]) {
  return tools.call({ type: "toolCall", id: `${name}-call`, name, arguments: args }, {})
}

function modelData(outcome: Awaited<ReturnType<typeof call>>): z.output<typeof ModelDataSchema> {
  return ModelDataSchema.parse(JSON.parse(outcome.modelBlocks?.[0]?.text ?? "null"))
}

function instrumentSymbols(outcome: Awaited<ReturnType<typeof call>>): string[] {
  const data = InstrumentResultSchema.parse(modelData(outcome))
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
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
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
  }
}
