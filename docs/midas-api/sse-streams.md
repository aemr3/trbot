# Server-sent-event streams

Base URL: `https://stream.getmidas.com`. This reference contains 31 resolved subscriptions. Every route is an authenticated `GET` with the common headers in [README.md](README.md#sse-transport). Unless noted otherwise, query and path values are required, comma-separated symbol lists are not percent-encoded by the Midas client, and each `data:` value is JSON. SSE subscriptions have no request body.

The machine-readable form is [sse-streams.json](sse-streams.json).

## Route index

| Subscription | Resolved path | Input | Output |
| --- | --- | --- | --- |
| `MemberFeature` | `/reactive-member-feature-api/api/v1/sse/member-features/{memberUid}` | `memberUid: string` | `MemberFeatureEvent` |
| `AdvancedChart` | `/reactive-chart-api/v1/charts/advanced-chart/stream?symbol={symbol}&country={country}` | `symbol`, `country` | `AdvancedChartUpdate` |
| `Candlestick` | `/reactive-chart-api/v2/charts/candle-stick/stream?symbol={symbol}&country={country}&currency={currency}&overnightEnabled=true` | `symbol`, `country`, `currency` | `CandlestickUpdate` |
| `Ticker` | `/reactive-market-api/v1/instruments/trade-price/stream?{country}={symbol}&overnightEnabled=true[&currency={currency}]` | one or more country-to-symbol pairs; optional currency | `TickerUpdate[]` |
| `OrderBook` | `/reactive-market-depth-api/v2/depth/stream?symbol={symbol}&type=DETAIL` | `symbol` | `OrderBookUpdate` |
| `OrderBookSummary` | `/reactive-market-depth-api/v2/depth/stream?symbol={symbol}&type=SUMMARY` | `symbol` | `OrderBookSummaryUpdate` |
| `Positions` | `/reactive-position-api/v2/stream/members/{memberUid}?eventTypes=position` | `memberUid` | `PositionUpdate[]` |
| `PositionAndOrder` | `/reactive-order-api/v2/stream/members/{memberUid}/assets/{assetUid}?eventTypes=position,order,dividendPayment,optionExercise` | `memberUid`, `assetUid` | Event-dependent arrays; see [Multiplexed event dispatch](#multiplexed-event-dispatch) |
| `OrderResult` | `/reactive-order-api/v1/stream/members/{memberUid}/order/{orderUid}` | `memberUid`, `orderUid` | `OrderResultUpdate` |
| `OptionExerciseResult` | `/reactive-order-api/v1/stream/members/{memberUid}/exercise/{exerciseUid}` | `memberUid`, `exerciseUid` | `OptionExerciseResultUpdate` |
| `Overview` | `/reactive-portfolio-api/v1/stream/overview-sse` | none | Event-dependent payload; see [Multiplexed event dispatch](#multiplexed-event-dispatch) |
| `PortfolioValue` | `/reactive-portfolio-api/v1/stream/portfolio-value?timeRange={timeRange}` | `timeRange` | `PortfolioValueUpdate` |
| `ReactivePortfolio` | `/reactive-portfolio-api/v1/stream/account-summary-evictions` | none | `void`; every frame is an invalidation signal |
| `PriceUpdate` | `/reactive-viop-api/v1/viop/futures/price-quote?symbol={symbols}` | comma-separated futures symbols | `FuturePriceUpdate` |
| `FuturePreviewUpdate` | `/reactive-viop-api/v1/viop/futures/detail?symbol={symbols}` | comma-separated futures symbols | `FuturePreviewUpdate` |
| `OptionPriceUpdate` | `/reactive-options-api/v1/options/trade-quotes/stream?symbol={symbols}` | comma-separated option symbols | `OptionPriceUpdate` |
| `OptionPreviewUpdate` | `/reactive-options-api/v1/options/preview/stream?symbol={symbols}&optionOrderType={orderType}` | symbol list, `OrderTransactionType.name` | `OptionPreviewUpdate` |
| `OptionChainUpdate` | `/reactive-options-api/v1/options/chain/stream?underlyingInstrumentSymbol={symbol}&date={yyyy-MM-dd}&optionType={optionType}&optionOrderType={orderType}` | underlying symbol, date, `OptionType.name`, `OrderTransactionType.name` | `OptionChainUpdate` |
| `OptionPositionUpdate` | `/reactive-order-api/v2/stream/members/{memberUid}/underlyingInstrument/{instrumentUid}` | `memberUid`, underlying instrument UID | `OptionPositionUpdate` |
| `WarrantPriceUpdate` | `/reactive-warrant-api/v1/price/stream?symbol={symbols}` | comma-separated warrant symbols | `WarrantPriceUpdate` |
| `WarrantChainUpdate` | `/reactive-warrant-api/v1/chain/stream?symbol={symbols}` | comma-separated underlying symbols | `WarrantChainUpdate` |
| `WarrantPositionUpdate` | `/reactive-order-api/v2/stream/members/{memberUid}/underlyingInstrument/{instrumentUid}` | `memberUid`, underlying instrument UID | `WarrantPositionUpdate` |
| `CryptoAdvancedChart` | `/crypto-chart-stream/v1/advanced-chart/stream?symbols={symbols}` | `symbols: string` | `CryptoAdvancedChartUpdate` |
| `CryptoCandlestick` | `/crypto-chart-stream/v1/candlestick/stream?symbols={symbols}` | `symbols: string` | `CryptoCandlestickUpdate` |
| `CryptoTicker` | `/crypto-price-stream/v1/prices/stream?symbols={symbols}[&sourcePage={sourcePage}][&orderType={orderType}][&ignoreSpread={boolean}]` | symbol list; three optional filters | `CryptoTickerUpdate[]` |
| `CryptoPositions` | `/crypto-portfolio-stream/v1/members/{memberUid}/positions/overview?instrument_uid={instrumentUid}&is_usdt_cash=false[&currency_instrument_uid={currencyInstrumentUid}]` | `memberUid`, `instrumentUid`; optional `currencyInstrumentUid` | `CryptoPositionUpdate[]` for event `position` |
| `CryptoOverview` | `/crypto-portfolio-stream/v1/members/{memberUid}/positions/overview?is_usdt_cash=true[&currency_instrument_symbol={currencyInstrumentSymbol}]` | `memberUid`; optional `currencyInstrumentSymbol` | Event-dependent arrays; see [Multiplexed event dispatch](#multiplexed-event-dispatch) |
| `CryptoOrderResult` | `/crypto-transaction-query-stream/v1/members/{memberUid}/orders/{orderUid}?streamVersion=2` | `memberUid`, `orderUid` | `CryptoOrderResultSubscriptionResponse` |
| `CryptoWithdrawResult` | `/crypto-transaction-query-stream/v1/members/{memberUid}/crypto-transfers/{transferUid}` | `memberUid`, `transferUid` | `CryptoWithdrawResultSubscriptionResponse` |
| `CryptoFixedStakingResult` | `/crypto-transaction-query-stream/v1/members/{memberUid}/crypto-staking-actions/{actionUid}` | `memberUid`, `actionUid` | `CryptoFixedStakingResultSubscriptionResponse` |
| `AIAnalysis` | `/pro-genai-api/v1/stream?instrumentUid={instrumentUid}&advancedTool={advancedTool}[&startDate={date}][&endDate={date}]` | instrument UID, `AdvancedTool.name`; optional UTC `yyyy-MM-dd` dates | `AIAnalysis` |

The same member/underlying-instrument route is used by separate option and warrant consumers; the selected event parser determines whether `o` or `w` identifies the instrument.

## Multiplexed event dispatch

The subscription label in the route index is a client-side name; it is not automatically the value of the SSE `event:` field. Most single-payload routes decode `data:` without requiring a particular event name. The following routes explicitly dispatch on `event:` and ignore unrecognized values:

| Subscription | Exact `event:` value | JSON in `data:` |
| --- | --- | --- |
| `PositionAndOrder` | `position` | `PositionUpdate[]` |
| `PositionAndOrder` | `order` | `OrderUpdate[]` |
| `PositionAndOrder` | `dividendPayment` | `DividendPaymentUpdate[]` |
| `PositionAndOrder` | `optionExercise` | `OptionExerciseUpdate[]` |
| `Overview` | `COLLATERAL_INFO` | `OverviewCollateralInfoPayload` |
| `Overview` | `VIOP_ACCOUNT_CREATED` | Payload is ignored; treat the event itself as the signal |
| `Overview` | `PENDING_STOCK` | `OverviewPendingStockPayload` |
| `Overview` | `PENDING_CASH` | `OverviewPendingCashPayload` |
| `CryptoPositions` | `position` | `CryptoPositionUpdate[]` |
| `CryptoOverview` | `position` | `CryptoPositionUpdate[]` |
| `CryptoOverview` | `cash` | `CryptoCashBalanceUpdate[]` |
| `CryptoOverview` | `performance` | `CryptoPortfolioPerformanceUpdate[]` |

For `CryptoPositions`, the wire payload is an array even though a consumer requesting one instrument may select and emit a single matching element after decoding it.

## Common scalar conventions

`Decimal` below means a JSON number or numeric string representing an arbitrary-precision decimal. `Timestamp` is a Unix timestamp; individual feeds use either seconds or milliseconds, so keep the value unchanged unless the endpoint contract specifies a unit. A property ending in `?` can be absent or `null`.

## Market and chart payloads

```ts
interface TickerUpdate {
  c: string          // country
  cr: string         // currency
  p: number          // price
  s: string          // symbol
  ss: string | null  // session status
  t: number          // timestamp
}

interface FuturePriceUpdate {
  s: string          // symbol
  p: number | null   // last price
  a: number | null   // ask
  b: number | null   // bid
  ss: string | null  // session status
  ts: number         // timestamp
}

interface FuturePreviewUpdate {
  symbol: string
  askSize: Decimal | null
  askValue: Decimal | null
  bidSize: Decimal | null
  bidValue: Decimal | null
  lastValue: Decimal | null
  marketSession: string | null
  statUpdates: Record<string, string>
  timestamp: string | number
}

interface CandlestickUpdate {
  tr: string          // chartTimeRange
  cl: Decimal         // close
  ed: number | null   // closeDate
  hi: Decimal         // high
  lo: Decimal         // low
  op: Decimal         // open
  t: number | null    // openDate
  ss: string | null   // sessionStatus
  s: string           // symbol
  ti: number          // timeIntervalInMillis
  vo: Decimal | null  // volume
}

interface IndicatorValue { id: string; v: Decimal }
interface BollingerValue { id: string; v: { l: Decimal; m: Decimal; u: Decimal } }
interface MacdValue { id: string; v: { h: Decimal; l: Decimal; s: Decimal } }

interface AdvancedChartUpdate {
  BOLL?: BollingerValue[] | null
  cl: Decimal
  ed?: number | null
  hi: Decimal
  i?: string | null
  lo: Decimal
  MA?: IndicatorValue[] | null
  MACD?: MacdValue[] | null
  op: Decimal
  t?: number | null
  RSI?: IndicatorValue[] | null
  s: string
  tr?: string | null
  vo2?: Decimal | null
}
```

## Order book payloads

```ts
interface OrderBookLevel {
  i: number // index
  l: number // lotCount
  o: number // orderCount
  p: number // price
  t: number // time
}

interface OrderBookDepth {
  bc: number              // buyCount
  b: OrderBookLevel[]     // buys
  sc: number              // sellCount
  s: OrderBookLevel[]     // sells
}

interface TradeItem {
  b: string // buyer
  d: string // direction
  id: string
  l: number // lotCount
  p: number // price
  s: string // seller
}
interface OrderBookTrades {
  e: boolean          // isEmpty
  t: TradeItem[]      // items
  l: number           // maxLength
  mt: string          // messageType
}

interface OrderBookUpdate {
  dpt?: OrderBookDepth | null
  t?: string | null        // infoMessage
  co?: boolean | null      // isInOrderCollection
  c?: boolean | null       // isMarketClosed
  m?: boolean | null       // maintenance
  s: string                // symbol
  trd?: OrderBookTrades | null
}

interface OrderBookSummaryUpdate {
  dpt?: { bc: number; sc: number } | null
  t?: string | null
  co?: boolean | null
  c?: boolean | null
  m?: boolean | null
}
```

## Account, order, and portfolio payloads

```ts
interface PositionUpdate {
  su: string          // stock/instrument UID
  q: number | string  // quantity
  ac?: number | null  // average cost
  c?: string | null   // country
  f?: boolean         // fictive position
  owe?: boolean       // has pending order
}

interface OrderUpdate {
  au: string
  cr: string
  lp?: number | null
  n?: number | null
  q?: number | null
  si?: string | null
  st?: string | null
  sd?: string | null
  su: string
  sp?: number | null
  tp?: number | null
  tf?: number | null
  t?: string | null
  u: string
}

interface DividendPaymentUpdate {
  au: string; cr: string; dpt: string; ga?: number | null; hd: boolean
  st?: string | null; sd?: string | null; sdc?: string | null
  su: string; u: string
}

interface OrderResultUpdate {
  isCompleteStatus: boolean | null
  messageCard: {
    type: string | null
    messageCard: {
      description: string | null; hasIcon: boolean | null; isClosable: boolean | null
      link: string | null; linkDeeplink: string | null; situation: string | null
      size: string | null; title: string | null
    } | null
  } | null
  orderActionList: string[] | null
  orderBodyItemList: ResultBodyItem[] | null
  realizedOrderInfo: {
    avgCostTitle: string
    pnlPercent: number
    filledPriceTitle: string
    avgCostValue: string
    filledPriceValue: string
  } | null
  status: string | null
  statusDescription: string | null
  summaryInfo: ResultSummaryInfo | null
  type: string | null
}

interface OptionExerciseResultUpdate {
  exerciseActionList: string[] | null
  exerciseBodyItemList: ResultBodyItem[] | null
  status: string | null
  statusDescription: string | null
  summaryInfo: ResultSummaryInfo | null
}

interface OptionExerciseUpdate {
  a: string   // accountId
  c: string   // country
  m: string   // memberId
  o: string   // optionId
  p: number   // price
  q: number   // quantity
  s: string   // status
  sd?: string | null // statusDescription
  tf: number  // commission
  u: string   // exercise id
  ui: string  // underlyingInstrumentId
}

interface ResultBodyItem {
  infoDescription: string | null
  infoTitle: string | null
  subTitle: string | null
  subValue: string | null
  title: string
  value: string
}

interface ResultSummaryInfo {
  analyticsEventName: string | null
  cardId: string | null
  detailAction: string | null
  detailDeepLink: string | null
  detailDescription: string | null
  detailTitle: string | null
  imageUrl: string | null
  message: string
  showOneTime: boolean | null
  title: string | null
}

interface OverviewCollateralInfoPayload {
  usableCollateral: number
  requiredMargin?: number | null
  depositExists?: boolean | null
  pendingDepositAmount?: number | null
  status?: string | null
}

interface OverviewPendingCashPayload {
  e: string[] // currencies
}

interface OverviewPendingStockPayload {
  e: Array<{
    c: string       // countryCode
    fn?: string | null // fullName
    i: string       // investmentType
    l?: string | null // logoUrl
    s: string       // symbol
    u: string       // uid
  }>
}

interface PnlUpdate {
  intradayPnlEur?: number | null
  intradayPnlTry?: number | null
  intradayPnlUsd?: number | null
  intradayTwr?: number | null
  pnlEur?: number | null
  pnlTry?: number | null
  pnlUsd?: number | null
  timeWeightedReturn?: number | null
}

interface PortfolioValueUpdate {
  pnl?: PnlUpdate | null
  e?: number | null // EUR portfolio value
  t?: number | null // TRY portfolio value
  u?: number | null // USD portfolio value
}
```

## Option and warrant payloads

```ts
interface OptionPriceUpdate {
  a?: number | null   // askValue
  b?: number | null   // bidValue
  p?: number | null   // lastValue
  mp?: number | null  // markValue
  s: string           // symbol
  ts: number          // timestamp
}

interface OptionPreviewUpdate {
  askSize?: Decimal | null
  askValue?: Decimal | null
  bidSize?: Decimal | null
  bidValue?: Decimal | null
  statUpdates: Record<string, string>
  symbol: string
}

interface OptionChainUpdate { symbol: string; updates: Record<string, string> }
interface OptionPositionUpdate { o: string; q: number } // optionId, quantity

interface WarrantPriceUpdate {
  as?: number | null
  a?: number | null
  bs?: number | null
  b?: number | null
  p?: number | null
  s: string
  ts: number
}

interface WarrantChainItem { symbol: string; updates: Record<string, string> }
interface WarrantChainUpdate {
  isMaintenanceModeActive: boolean
  isMarketClosed: boolean
  warrantUpdates: WarrantChainItem[]
}
interface WarrantPositionUpdate { q: number; w: string } // quantity, warrantId
```

## Crypto payloads

```ts
interface CryptoCandlestickUpdate {
  tr: string; c: Decimal; ct?: number | null; h: Decimal; l: Decimal
  o: Decimal; ot?: number | null; v: Decimal
}

interface CryptoTickerUpdate {
  bp?: number | null  // buyPrice
  st?: boolean | null // isStale
  c: number           // price
  sp?: number | null  // sellPrice
  s: string           // symbol
  t: number           // timestamp
}

interface CryptoPositionUpdate {
  a?: number | null   // allTimeAvgPrice
  i: string           // cryptoId
  ci: string          // currencyCryptoId
  pa?: number | null  // last24HoursAvgPrice
  d?: number | null   // portfolioDiversity
  q: number           // quantity
}

interface CryptoCashBalanceUpdate { c: string; b: number; nb: number }
interface CryptoPortfolioPerformanceUpdate { v: number; p?: number | null; t: string }

interface CryptoIndicatorPoint { c: string; ot: number; v: Decimal }
interface CryptoAdvancedChartUpdate {
  BOLL?: Array<{ id: string; v: {
    l: CryptoIndicatorPoint; m: CryptoIndicatorPoint; u: CryptoIndicatorPoint
  } }> | null
  c: Decimal; ct?: number | null; h: Decimal
  IC?: Array<{ id: string; v: {
    c: CryptoIndicatorPoint; k: CryptoIndicatorPoint; sa: CryptoIndicatorPoint
    sb: CryptoIndicatorPoint; t: CryptoIndicatorPoint
  } }> | null
  i?: string | null; l: Decimal
  MA?: Array<{ id: string; v: CryptoIndicatorPoint }> | null
  MACD?: Array<{ id: string; v: {
    h: CryptoIndicatorPoint; l: CryptoIndicatorPoint; s: CryptoIndicatorPoint
  } }> | null
  o: Decimal; ot?: number | null
  RSI?: Array<{ id: string; v: CryptoIndicatorPoint }> | null
  SUPERTREND?: Array<{ id: string; v: {
    b: CryptoIndicatorPoint; d: CryptoIndicatorPoint
    t: CryptoIndicatorPoint; u: CryptoIndicatorPoint
  } }> | null
  s: string; tr?: string | null; v: Decimal
}

interface CryptoOrderResultSubscriptionStatus {
  status: string
  title: string
  colorCode: string
}

interface CryptoOrderResultSubscriptionItemHorizontal {
  title: string
  titleDescription: string | null
  trailing: string
  trailingDescription: string | null
}

interface CryptoOrderResultSubscriptionInfo {
  message: string
  title: string | null
  imageUrl: string | null
  detailAction: string | null
  detailTitle: string | null
  detailDescription: string | null
  detailDeepLink: string | null
  showOneTime: boolean | null
  cardId: string | null
  analyticsEventName: string | null
}

interface CryptoOrderResultSubscriptionMessageCard {
  situation: string
  hasIcon: boolean
  title: string | null
  description: string
  linkText: string | null
  linkDeepLink: string | null
  isClosable: boolean
  size: string | null
}

interface CryptoOrderResultSubscriptionResponse {
  status: CryptoOrderResultSubscriptionStatus
  orderTypeText: string | null
  orderActionItems: string[]
  orderBodyItemsHorizontal: CryptoOrderResultSubscriptionItemHorizontal[]
  summaryInfo: CryptoOrderResultSubscriptionInfo | null
  messageCard: CryptoOrderResultSubscriptionMessageCard | null
  isLoading: boolean | null
}

interface CryptoWithdrawResultSubscriptionStatus {
  status: string
  title: string
  colorCode: string
  description: string | null
}

interface CryptoWithdrawResultSubscriptionItem {
  title: string
  body: string
  trailingDescription: string | null
}

interface CryptoWithdrawResultSubscriptionResponse {
  status: CryptoWithdrawResultSubscriptionStatus
  transferTypeText: string | null
  actionItems: string[]
  bodyItems: CryptoWithdrawResultSubscriptionItem[]
}

interface CryptoFixedStakingResultSubscriptionStatus {
  status: string
  title: string
  colorCode: string
  description: string | null
}

interface CryptoFixedStakingResultSubscriptionItem {
  title: string
  body: string
  trailingDescription: string | null
}

interface CryptoFixedStakingResultSubscriptionResponse {
  title: string
  description: string
  status: CryptoFixedStakingResultSubscriptionStatus
  actionItems: string[]
  bodyItems: CryptoFixedStakingResultSubscriptionItem[]
}
```

## Member feature and AI-analysis payloads

```ts
interface MemberFeatureEvent {
  eventType: "WHOLE_STATE" | "CHANGE"
  features: Record<string, boolean>
}

interface AIAnalysis {
  type: string
  text: string | null
  analysisUid: string | null
  completedAt: string | number | null
  expiresAt: string | number | null
  tradingSessionStatus: string | null
  expiresInMillis: number | null
  code: number | null
  feedbackState: string
  remainingMs: number | null
  retryAllowedMessage: string | null
  quotaStatus: string | null
  showFeedbackQuestion: boolean
  hasFeedbackDetail: boolean
}
```
