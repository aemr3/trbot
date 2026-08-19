import { Type } from "@earendil-works/pi-ai"
import type { BrokerageDistributionSource, BrokerageSide } from "@trbot/market/brokerage.ts"
import type { BrokerageDateRange } from "@trbot/market/broker-calendar.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { DepthBook, DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteStream, EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import { resolveViopInstrument, type ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { NewsSource } from "@trbot/market/news.ts"
import type { SettlementMode, SettlementSource } from "@trbot/market/settlement.ts"
import type { MemberFeatureSource } from "@trbot/member/features.ts"
import type { AccountSource } from "@trbot/trading/account.ts"
import type { ViopOrderCancellationSource, ViopOrderSource } from "@trbot/trading/order.ts"
import type { StopRule } from "@trbot/trading/stop.ts"
import { toolText, type ChatTool } from "./tool.ts"

const STREAM_SNAPSHOT_TIMEOUT_MS = 10_000
const MAX_ARTICLE_CHARS = 30_000

const SymbolParameter = Type.String({
  description: "VIOP contract or underlying symbol, such as F_ASELS0826 or ASELS",
  minLength: 1,
  maxLength: 80,
})
const InstrumentLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 }))
const ResultLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 }))
const CandleRange = Type.Union([
  Type.Literal("INTRADAY"),
  Type.Literal("WEEK"),
  Type.Literal("MONTH"),
  Type.Literal("THREE_MONTH"),
  Type.Literal("YEAR"),
  Type.Literal("FIVE_YEAR"),
])
const CandleInterval = Type.Union([
  Type.Literal("MIN_5"),
  Type.Literal("MIN_10"),
  Type.Literal("MIN_15"),
  Type.Literal("MIN_30"),
  Type.Literal("HOUR_1"),
  Type.Literal("HOUR_4"),
  Type.Literal("DAY_1"),
  Type.Literal("WEEK_1"),
  Type.Literal("MONTH_1"),
])
const CandleTarget = Type.Union([
  Type.Literal("UNDERLYING"),
  Type.Literal("INSTRUMENT"),
  Type.Literal("BIST_100"),
  Type.Literal("BIST_30"),
])
const PortfolioRange = Type.Union([
  Type.Literal("WEEK"),
  Type.Literal("MONTH"),
  Type.Literal("THREE_MONTH"),
  Type.Literal("YEAR_TO_DATE"),
  Type.Literal("YEAR"),
  Type.Literal("ALL_TIME"),
])
const IsoDate = Type.String({ description: "Exchange-local date in YYYY-MM-DD format", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })

const ListInstrumentsParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Symbol or name fragment to search for", maxLength: 80 })),
  limit: InstrumentLimit,
})
const SymbolOnlyParameters = Type.Object({ symbol: SymbolParameter })
const CandleParameters = Type.Object({
  symbol: Type.Optional(Type.String({
    description: "VIOP contract, underlying, or index alias such as ASELS, XU100, XU030, BIST100, or BIST30",
    minLength: 1,
    maxLength: 80,
  })),
  range: CandleRange,
  interval: CandleInterval,
  target: Type.Optional(CandleTarget),
  limit: Type.Optional(Type.Integer({ description: "Return only this many newest candles; omit for the complete series", minimum: 1 })),
})
const AccountParameters = Type.Object({ range: Type.Optional(PortfolioRange) })
const DepthParameters = Type.Object({
  symbol: Type.String({
    description: "Underlying BIST cash-equity symbol, such as ASELS or AKBNK. Never pass a VIOP contract symbol.",
    minLength: 1,
    maxLength: 80,
  }),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  trades: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, default: 25 })),
})
const BrokerageParameters = Type.Object({
  symbol: SymbolParameter,
  side: Type.Union([Type.Literal("BUYER"), Type.Literal("SELLER")]),
  start: Type.Optional(IsoDate),
  end: Type.Optional(IsoDate),
  limit: ResultLimit,
})
const SettlementParameters = Type.Object({
  symbol: SymbolParameter,
  mode: Type.Union([Type.Literal("HELD"), Type.Literal("GAINED"), Type.Literal("LOST")], {
    description: "HELD ranks current custody holdings. GAINED and LOST rank lot changes over the requested date range.",
  }),
  start: Type.Optional(Type.String({
    description: "First exchange-local date in YYYY-MM-DD format. Required for GAINED and LOST; omit only for the current HELD view.",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  end: Type.Optional(Type.String({
    description: "Last exchange-local date in YYYY-MM-DD format. Omit for a single-day reading starting on start.",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  limit: ResultLimit,
})
const ListNewsParameters = Type.Object({
  symbol: Type.Optional(SymbolParameter),
  limit: ResultLimit,
})
const ArticleParameters = Type.Object({
  uid: Type.String({ description: "Article UID returned by list_news", minLength: 1, maxLength: 300 }),
})
const EmptyParameters = Type.Object({})

export interface MarketDataSources {
  instruments: ViopInstrumentSource
  candles: CandleSource
  news: NewsSource
  account: AccountSource
  orders: Pick<ViopOrderSource, "prepareOrder"> & Pick<ViopOrderCancellationSource, "listPendingOrders">
  brokerage: BrokerageDistributionSource
  settlement: SettlementSource
  memberFeatures: MemberFeatureSource
  openDepthStream(): DepthStream
  openEquityQuoteStream(): EquityQuoteStream
}

export interface MarketDataToolClients {
  /** Resolved per call because provider recovery replaces every source object. */
  sources(): MarketDataSources
  stops: { list(): Promise<StopRule[]> }
}

/** Read-only market, portfolio, broker, and news capabilities available to every chat agent. */
export function marketDataTools(clients: MarketDataToolClients): ChatTool[] {
  return [
    listInstrumentsTool(clients),
    viopQuoteTool(clients),
    contractDetailsTool(clients),
    candlesTool(clients),
    accountTool(clients),
    orderBookTool(clients),
    equityQuoteTool(clients),
    brokerageTool(clients),
    settlementTool(clients),
    listNewsTool(clients),
    newsArticleTool(clients),
    pendingOrdersTool(clients),
    subscriptionFeaturesTool(clients),
    stopRulesTool(clients),
  ]
}

function listInstrumentsTool(clients: MarketDataToolClients): ChatTool<typeof ListInstrumentsParameters> {
  return {
    definition: {
      name: "list_instruments",
      description: "List active front-month VIOP contracts with instrument UIDs, current prices, changes, and volume.",
      parameters: ListInstrumentsParameters,
    },
    run: async ({ query, limit }, options) => {
      const instruments = await clients.sources().instruments.listInstruments({ signal: options.signal })
      const wanted = query?.trim().toUpperCase()
      const matches = instruments.filter((instrument) => !wanted || [
        instrument.symbol,
        instrument.displayName,
        instrument.underlyingSymbol,
      ].some((value) => value?.toUpperCase().includes(wanted)))
      const returned = matches.slice(0, limit ?? 25)
      return dataOutcome(
        `Found ${matches.length} matching VIOP contract${matches.length === 1 ? "" : "s"}; returned ${returned.length}.`,
        { matched: matches.length, instruments: returned },
      )
    },
  }
}

function viopQuoteTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_viop_quote",
      description: [
        "Get the latest VIOP last, bid, ask, exchange limits, collateral, contract size, and current position quantity.",
        "When quote sources have no last price, returns the newest VIOP contract candle close with its source and timestamp.",
      ].join(" "),
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const quote = await sources.orders.prepareOrder({
        instrumentUid: instrument.uid,
        side: "BUY",
        signal: options.signal,
      })
      let lastPrice = quote.lastPrice ?? instrument.lastPrice
      const lastPriceSource = quote.lastPrice !== null
        ? "CONTRACT_QUOTE"
        : instrument.lastPrice !== null
          ? "INSTRUMENT_LIST"
          : "CANDLE_CLOSE"
      let lastPriceTimestamp: number | null = null
      let candleInterval: string | null = null
      if (lastPrice === null) {
        const series = await sources.candles.loadCandles(instrument.uid, "WEEK", "HOUR_1", {
          signal: options.signal,
          target: "INSTRUMENT",
        })
        const candle = series.candles.at(-1)
        if (!candle) throw new Error(`No quote or candle price is available for ${instrument.symbol}`)
        lastPrice = candle.close
        lastPriceTimestamp = candle.timestamp
        candleInterval = series.interval
      }
      return dataOutcome(`Read VIOP quote for ${instrument.displayName}.`, {
        readAt: Date.now(),
        instrument,
        quote: {
          lastPrice,
          lastPriceSource,
          lastPriceTimestamp,
          candleInterval,
          bid: quote.bid,
          ask: quote.ask,
          lowerLimit: quote.lowerLimit,
          upperLimit: quote.upperLimit,
          priceScale: quote.priceScale,
          contractSize: quote.contractSize,
          initialCollateral: quote.initialCollateral,
          availableCollateral: quote.availableCollateral,
          currentPositionQuantity: quote.currentPositionQuantity,
        },
      })
    },
  }
}

function contractDetailsTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_contract_details",
      description: "Get VIOP contract leverage, size, collateral, expiry, session range, settlement, volume, and open interest.",
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const source = clients.sources().instruments
      const instrument = resolveViopInstrument(await source.listInstruments({ signal: options.signal }), symbol)
      if (!source.loadContractDetails) throw new Error("Contract details are unavailable")
      const details = await source.loadContractDetails(instrument.uid, { signal: options.signal })
      return dataOutcome(`Read contract details for ${instrument.displayName}.`, { instrument, details })
    },
  }
}

function candlesTool(clients: MarketDataToolClients): ChatTool<typeof CandleParameters> {
  return {
    definition: {
      name: "get_candles",
      description: [
        "Read the complete OHLCV candle series for a VIOP contract, its underlying equity, BIST 100, or BIST 30.",
        "For indices, pass XU100/XU030 as symbol or select BIST_100/BIST_30 without a symbol.",
      ].join(" "),
      parameters: CandleParameters,
    },
    run: async ({ symbol, range, interval, target, limit }, options) => {
      const sources = clients.sources()
      const resolvedTarget = indexTarget(target, symbol) ?? target ?? "INSTRUMENT"
      const indexSymbol = resolvedTarget === "BIST_100" ? "XU100" : resolvedTarget === "BIST_30" ? "XU030" : null
      const instrument = indexSymbol
        ? null
        : resolveViopInstrument(
            await sources.instruments.listInstruments({ signal: options.signal }),
            requireSymbol(symbol),
          )
      const series = await sources.candles.loadCandles(instrument?.uid ?? indexSymbol!, range, interval, {
        signal: options.signal,
        target: resolvedTarget,
      })
      const candles = limit === undefined ? series.candles : series.candles.slice(-limit)
      return dataOutcome(`Read ${candles.length} ${interval} candles for ${indexSymbol ?? instrument?.displayName}.`, {
        instrument,
        symbol: indexSymbol ?? instrument?.symbol,
        target: resolvedTarget,
        range: series.range,
        interval: series.interval,
        intervalMs: series.intervalMs,
        currency: series.currency,
        availableIntervalsByRange: series.availableIntervalsByRange,
        totalCandles: series.candles.length,
        candles,
      })
    },
  }
}

function requireSymbol(symbol: string | undefined): string {
  if (!symbol?.trim()) throw new Error("A VIOP contract or underlying symbol is required for these candles")
  return symbol
}

function indexTarget(
  target: "UNDERLYING" | "INSTRUMENT" | "BIST_100" | "BIST_30" | undefined,
  symbol: string | undefined,
): "BIST_100" | "BIST_30" | null {
  if (target === "BIST_100" || target === "BIST_30") return target
  const alias = symbol?.replaceAll(/[^A-Z0-9]/gi, "").toUpperCase()
  if (alias === "XU100" || alias === "BIST100") return "BIST_100"
  if (alias === "XU030" || alias === "XU30" || alias === "BIST30") return "BIST_30"
  return null
}

function accountTool(clients: MarketDataToolClients): ChatTool<typeof AccountParameters> {
  return {
    definition: {
      name: "get_account",
      description: "Read portfolio collateral, P/L, performance, positions, and account orders without changing anything.",
      parameters: AccountParameters,
    },
    run: async ({ range }, options) => {
      const snapshot = await clients.sources().account.loadAccount({
        signal: options.signal,
        portfolioRange: range,
      })
      return dataOutcome(`Read account with ${snapshot.positions.length} open position${snapshot.positions.length === 1 ? "" : "s"}.`, snapshot)
    },
  }
}

function orderBookTool(clients: MarketDataToolClients): ChatTool<typeof DepthParameters> {
  return {
    definition: {
      name: "get_order_book",
      description: [
        "Take a live cash-equity order-book snapshot for an underlying BIST stock,",
        "with bid/ask levels, total lots, and recent trades. VIOP contract order books are not available.",
        "Pass the underlying equity ticker itself, such as AKBNK, never a contract such as F_AKBNK0826.",
      ].join(" "),
      parameters: DepthParameters,
    },
    run: async ({ symbol, levels, trades }, options) => {
      const sources = clients.sources()
      const underlyingSymbol = symbol.trim().toUpperCase()
      if (underlyingSymbol.startsWith("F_")) {
        throw new Error("VIOP contract order books are unavailable; call get_order_book with the underlying equity symbol")
      }
      const book = await readDepthSnapshot(sources.openDepthStream(), underlyingSymbol, options.signal)
      const normalized = {
        ...book,
        underlyingSymbol,
        bids: book.bids.slice(0, levels ?? 10),
        asks: book.asks.slice(0, levels ?? 10),
        trades: book.trades.slice(0, trades ?? 25),
      }
      return dataOutcome(`Read underlying equity order book for ${underlyingSymbol}.`, normalized)
    },
  }
}

function equityQuoteTool(clients: MarketDataToolClients): ChatTool<typeof SymbolOnlyParameters> {
  return {
    definition: {
      name: "get_equity_quote",
      description: [
        "Get the latest price for the BIST equity underlying a VIOP contract.",
        "Uses a live trade tick when available and otherwise returns the newest underlying-equity candle close,",
        "clearly labeled with its source and timestamp.",
      ].join(" "),
      parameters: SymbolOnlyParameters,
    },
    run: async ({ symbol }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      if (!instrument.underlyingSymbol) throw new Error(`${instrument.symbol} has no underlying equity symbol`)
      try {
        const quote = await readEquityQuote(
          sources.openEquityQuoteStream(),
          instrument.underlyingSymbol,
          options.signal,
        )
        return dataOutcome(`Read live equity quote for ${quote.symbol}.`, { ...quote, source: "LIVE_TICK" })
      } catch (error) {
        if (options.signal?.aborted) throw error
        const series = await sources.candles.loadCandles(instrument.uid, "WEEK", "MIN_10", {
          signal: options.signal,
          target: "UNDERLYING",
        })
        const candle = series.candles.at(-1)
        if (!candle) throw new Error(`No live quote or candle price is available for ${instrument.underlyingSymbol}`)
        const quote = {
          symbol: instrument.underlyingSymbol,
          lastPrice: candle.close,
          timestamp: candle.timestamp,
          sessionStatus: null,
          source: "CANDLE_CLOSE",
          candleRange: series.range,
          candleInterval: series.interval,
        }
        return dataOutcome(
          `Live quote unavailable; read the latest ${series.interval} candle close for ${instrument.underlyingSymbol}.`,
          quote,
        )
      }
    },
  }
}

function brokerageTool(clients: MarketDataToolClients): ChatTool<typeof BrokerageParameters> {
  return {
    definition: {
      name: "get_brokerage_distribution",
      description: "Rank brokerage houses accumulating or distributing the underlying equity over a date range.",
      parameters: BrokerageParameters,
    },
    run: async ({ symbol, side, start, end, limit }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const range = dateRange(start, end)
      const distribution = await sources.brokerage.loadDistribution({
        instrumentUid: instrument.uid,
        side: side as BrokerageSide,
        range,
        signal: options.signal,
      })
      return dataOutcome(`Read ${side.toLowerCase()} brokerage distribution for ${instrument.displayName}.`, {
        instrument,
        range,
        ...distribution,
        shares: distribution.shares.slice(0, limit ?? 20),
        totalShares: distribution.shares.length,
      })
    },
  }
}

function settlementTool(clients: MarketDataToolClients): ChatTool<typeof SettlementParameters> {
  return {
    definition: {
      name: "get_settlement",
      description: [
        "Read brokerage custody holdings or lot changes for the underlying cash equity.",
        "HELD may omit dates and returns availableDates.",
        "GAINED and LOST require start; set end for a multi-day range or omit end for that single day.",
        "If valid settlement dates are unknown, call HELD first and choose from its availableDates.",
      ].join(" "),
      parameters: SettlementParameters,
    },
    run: async ({ symbol, mode, start, end, limit }, options) => {
      if (mode !== "HELD" && !start) {
        throw new Error(
          `get_settlement mode ${mode} requires start in YYYY-MM-DD format. `
          + "Call get_settlement with mode HELD first if you need its availableDates.",
        )
      }
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const range = dateRange(start, end)
      const settlement = await sources.settlement.loadSettlement({
        instrumentUid: instrument.uid,
        mode: mode as SettlementMode,
        range,
        signal: options.signal,
      })
      return dataOutcome(`Read ${mode.toLowerCase()} settlement for ${instrument.displayName}.`, {
        instrument,
        range,
        ...settlement,
        holdings: settlement.holdings.slice(0, limit ?? 20),
        totalHoldings: settlement.holdings.length,
      })
    },
  }
}

function listNewsTool(clients: MarketDataToolClients): ChatTool<typeof ListNewsParameters> {
  return {
    definition: {
      name: "list_news",
      description: "List recent general market news or news for the equity underlying a VIOP contract. Use get_news_article for the body.",
      parameters: ListNewsParameters,
    },
    run: async ({ symbol, limit }, options) => {
      const sources = clients.sources()
      const instrument = symbol
        ? resolveViopInstrument(await sources.instruments.listInstruments({ signal: options.signal }), symbol)
        : null
      const articles = await sources.news.listNews({ instrumentUid: instrument?.uid, signal: options.signal })
      const returned = articles.slice(0, limit ?? 20).map(({ body: _body, ...article }) => article)
      return dataOutcome(`Found ${articles.length} news article${articles.length === 1 ? "" : "s"}; returned ${returned.length}.`, {
        instrument,
        totalArticles: articles.length,
        articles: returned,
      })
    },
  }
}

function newsArticleTool(clients: MarketDataToolClients): ChatTool<typeof ArticleParameters> {
  return {
    definition: {
      name: "get_news_article",
      description: "Read the full body and attachments of a news article returned by list_news.",
      parameters: ArticleParameters,
    },
    run: async ({ uid }, options) => {
      const article = await clients.sources().news.getArticle(uid, { signal: options.signal })
      if (!article) throw new Error(`No news article found with UID ${uid}`)
      const truncated = article.body.length > MAX_ARTICLE_CHARS
      const normalized = {
        ...article,
        body: article.body.slice(0, MAX_ARTICLE_CHARS),
        bodyTruncated: truncated,
      }
      return dataOutcome(`Read news article: ${article.headline}.`, normalized)
    },
  }
}

function pendingOrdersTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "list_pending_orders",
      description: "List pending VIOP orders without modifying or cancelling them.",
      parameters: EmptyParameters,
    },
    run: async (_args, options) => {
      const orders = await clients.sources().orders.listPendingOrders({ signal: options.signal })
      return dataOutcome(`Found ${orders.length} pending order${orders.length === 1 ? "" : "s"}.`, { orders })
    },
  }
}

function subscriptionFeaturesTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "get_data_entitlements",
      description: "List the signed-in account's enabled data entitlements, such as market depth, brokerage distribution, and settlement access.",
      parameters: EmptyParameters,
    },
    run: async (_args, options) => {
      const features = await clients.sources().memberFeatures.loadFeatures({ signal: options.signal })
      return dataOutcome("Read data entitlements.", { enabled: features.list() })
    },
  }
}

function stopRulesTool(clients: MarketDataToolClients): ChatTool<typeof EmptyParameters> {
  return {
    definition: {
      name: "list_stop_rules",
      description: "List protective VIOP stop and target rules, including their levels, state, and position ownership.",
      parameters: EmptyParameters,
    },
    run: async () => {
      const rules = await clients.stops.list()
      return dataOutcome(`Found ${rules.length} stop or target rule${rules.length === 1 ? "" : "s"}.`, { rules })
    },
  }
}

function dataOutcome(summary: string, data: unknown) {
  return {
    blocks: [toolText(summary)],
    modelBlocks: [toolText(JSON.stringify(data))],
    details: data,
    isError: false,
  }
}

function dateRange(start?: string, end?: string): BrokerageDateRange {
  if (end && !start) throw new Error("A brokerage range cannot have an end date without a start date")
  if (start && end && end < start) throw new Error("The brokerage range end date cannot precede its start date")
  return { start: start ?? null, end: end ?? null }
}

function readDepthSnapshot(stream: DepthStream, symbol: string, signal?: AbortSignal): Promise<DepthBook> {
  return streamSnapshot<DepthBook>({
    signal,
    start: () => stream.start(symbol),
    stop: () => stream.stop(),
    subscribe: (resolve, reject) => {
      stream.subscribe(resolve)
      stream.onStatusChange((status) => {
        if (status === "unavailable") reject(new Error(`Order book is unavailable for ${symbol}`))
      })
    },
    timeoutMessage: `Timed out waiting for the ${symbol} order book`,
  })
}

function readEquityQuote(stream: EquityQuoteStream, symbol: string, signal?: AbortSignal): Promise<EquityQuoteUpdate> {
  return streamSnapshot<EquityQuoteUpdate>({
    signal,
    start: () => stream.start(symbol),
    stop: () => stream.stop(),
    subscribe: (resolve) => stream.subscribe(resolve),
    timeoutMessage: `Timed out waiting for an equity quote for ${symbol}`,
  })
}

function streamSnapshot<T>(options: {
  signal?: AbortSignal
  start: () => void
  stop: () => void
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void
  timeoutMessage: string
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T } | { error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      options.stop()
      if ("value" in result) resolve(result.value)
      else reject(result.error)
    }
    const onAbort = () => finish({ error: new Error("Market-data request was cancelled") })
    const timer = setTimeout(() => finish({ error: new Error(options.timeoutMessage) }), STREAM_SNAPSHOT_TIMEOUT_MS)
    options.subscribe((value) => finish({ value }), (error) => finish({ error }))
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    else {
      try {
        options.start()
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
  })
}
