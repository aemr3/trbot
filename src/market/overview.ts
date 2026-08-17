import { describeRange, type BrokerageDatePreset, type BrokerageDateRange } from "./broker-calendar.ts"
import type { BrokerageDistribution } from "./brokerage.ts"
import type { CandleSeries } from "./candle.ts"
import type { DepthBook } from "./depth.ts"
import type { SettlementAnalysis } from "./settlement.ts"
import type { TradeFlowSummary } from "./trade-flow.ts"

// A compact, deterministic reading of everything the app knows about an
// instrument's broker activity: the live book and tape, the range's trade-flow
// distribution, and the settled custody register. All arithmetic happens here;
// the AI layer only phrases what these numbers already say.

// The overview reads the market at two horizons. The intraday view carries the
// session's microstructure — book, tape, session candles — with the daily trend
// as context; the daily view carries the standing picture — flow, the custody
// register and the daily history — and skips the live noise.
export const OVERVIEW_MODES = ["INTRADAY", "DAILY"] as const
export type OverviewMode = (typeof OVERVIEW_MODES)[number]

const TOP_HOUSE_COUNT = 5
// The joined table unions several top-N lists, so it gets a little more room.
const MAX_JOINED_HOUSES = 8
// How much price history the model reads: enough intraday candles for the
// session's structure and enough daily ones for the standing trend, without
// letting the prompt balloon.
const MAX_INTRADAY_CANDLES = 60
const MAX_DAILY_CANDLES = 90
// The intraday view keeps a shorter daily tail, for trend context only.
const MAX_CONTEXT_DAILY_CANDLES = 30

export interface OverviewInstrument {
  symbol: string
  displayName: string | null
  lastPrice: number | null
}

export interface OverviewBook {
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  bidLots: number | null
  askLots: number | null
  // Bid share of all resting lots, 0..1.
  bidShare: number | null
  marketClosed: boolean
}

export interface OverviewTape {
  tradeCount: number
  aggressorBuyLots: number
  aggressorSellLots: number
  brokers: Array<{ brokerage: string; boughtLots: number; soldLots: number; netLots: number }>
}

export interface OverviewFlowHouse {
  brokerage: string
  netLots: number
  averagePrice: number
  percentage: number
}

export interface OverviewFlow {
  rangeLabel: string
  live: boolean
  buyers: OverviewFlowHouse[]
  sellers: OverviewFlowHouse[]
}

export interface OverviewCustodyHouse {
  brokerage: string
  // Signed: positive lots entered the house's custody, negative left it.
  lotChange: number | null
  percentage: number
}

export interface OverviewCustody {
  lastUpdate: string | null
  live: boolean
  gainers: OverviewCustodyHouse[]
  losers: OverviewCustodyHouse[]
  unavailableMessage: string | null
}

// One house seen across both feeds: what it traded over the range and what its
// settled custody position did. Flow fields are null when the house only shows
// up in the register, custody fields when it only shows up in the flow.
export interface OverviewHouse {
  brokerage: string
  flowBoughtLots: number | null
  flowSoldLots: number | null
  flowNetLots: number | null
  flowAveragePrice: number | null
  // Last price minus the house's VWAP: positive means its buys are in profit.
  averagePriceVsLast: number | null
  custodyLotChange: number | null
  custodyShare: number | null
}

export interface OverviewCandle {
  // Exchange-local time, "YYYY-MM-DD HH:mm".
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface OverviewCandleSeries {
  interval: string
  candles: OverviewCandle[]
}

// The instrument's own price history on two timeframes: the intraday series
// carries the session's structure, the daily one the standing trend.
export interface OverviewHistory {
  intraday: OverviewCandleSeries | null
  daily: OverviewCandleSeries | null
}

export interface MarketOverviewDigest {
  mode: OverviewMode
  instrument: OverviewInstrument
  book: OverviewBook | null
  tape: OverviewTape | null
  flow: OverviewFlow | null
  custody: OverviewCustody | null
  houses: OverviewHouse[]
  history: OverviewHistory | null
}

// A finished overview run, kept per instrument so revisiting a ticker shows
// the last analysis instead of paying for a new one.
export interface OverviewSnapshot {
  digest: MarketOverviewDigest
  commentary: string
  generatedAt: number
}

// A snapshot together with the instrument and horizon it belongs to.
export interface StoredOverviewSnapshot extends OverviewSnapshot {
  instrumentUid: string
  mode: OverviewMode
}

// Snapshots outlive the process so a reopened app starts with its last reading.
export interface OverviewSnapshotStore {
  list(): Promise<StoredOverviewSnapshot[]>
  put(snapshot: StoredOverviewSnapshot): Promise<void>
}

export interface OverviewDigestInputs {
  mode: OverviewMode
  instrument: OverviewInstrument
  book?: DepthBook | null
  tape?: TradeFlowSummary | null
  buyerFlow?: BrokerageDistribution | null
  sellerFlow?: BrokerageDistribution | null
  custodyGained?: SettlementAnalysis | null
  custodyLost?: SettlementAnalysis | null
  intradayCandles?: CandleSeries | null
  dailyCandles?: CandleSeries | null
  range: BrokerageDateRange
  presets?: BrokerageDatePreset[]
}

export function buildOverviewDigest(inputs: OverviewDigestInputs): MarketOverviewDigest {
  const intraday = inputs.mode === "INTRADAY"
  const flow = flowSection(inputs)
  // The register lags a session, so it only belongs to the daily reading; the
  // live book and tape only to the intraday one.
  const custody = intraday ? null : custodySection(inputs)
  return {
    mode: inputs.mode,
    instrument: inputs.instrument,
    book: intraday && inputs.book ? bookSection(inputs.book) : null,
    tape: intraday ? tapeSection(inputs.tape ?? null) : null,
    flow,
    custody,
    houses: joinHouses(flow, custody, inputs.instrument.lastPrice),
    history: historySection(inputs),
  }
}

// Digests are compared between runs to skip regenerating commentary when
// nothing moved; they are plain data, so structural equality is enough.
export function isSameDigest(left: MarketOverviewDigest, right: MarketOverviewDigest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function bookSection(book: DepthBook): OverviewBook {
  const bestBid = book.bids[0]?.price ?? null
  const bestAsk = book.asks[0]?.price ?? null
  const bidLots = book.buyLots ?? sumLots(book.bids)
  const askLots = book.sellLots ?? sumLots(book.asks)
  const restingLots = (bidLots ?? 0) + (askLots ?? 0)
  return {
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid) : null,
    bidLots,
    askLots,
    bidShare: restingLots > 0 ? round((bidLots ?? 0) / restingLots, 3) : null,
    marketClosed: book.marketClosed,
  }
}

function tapeSection(tape: TradeFlowSummary | null): OverviewTape | null {
  if (!tape || tape.tradeCount === 0) return null
  return {
    tradeCount: tape.tradeCount,
    aggressorBuyLots: tape.aggressorBuyLots,
    aggressorSellLots: tape.aggressorSellLots,
    brokers: tape.brokers.slice(0, TOP_HOUSE_COUNT),
  }
}

function flowSection(inputs: OverviewDigestInputs): OverviewFlow | null {
  const { buyerFlow, sellerFlow } = inputs
  if (!buyerFlow && !sellerFlow) return null
  const presets = inputs.presets ?? buyerFlow?.presets ?? sellerFlow?.presets ?? []
  return {
    rangeLabel: describeRange(inputs.range, presets),
    live: buyerFlow?.live ?? sellerFlow?.live ?? false,
    buyers: flowHouses(buyerFlow),
    sellers: flowHouses(sellerFlow),
  }
}

function flowHouses(distribution: BrokerageDistribution | null | undefined): OverviewFlowHouse[] {
  if (!distribution) return []
  return distribution.shares.slice(0, TOP_HOUSE_COUNT).map((share) => ({
    brokerage: share.brokerage,
    netLots: share.netLots,
    averagePrice: share.averagePrice,
    percentage: share.percentage,
  }))
}

function custodySection(inputs: OverviewDigestInputs): OverviewCustody | null {
  const { custodyGained, custodyLost } = inputs
  if (!custodyGained && !custodyLost) return null
  return {
    lastUpdate: custodyGained?.lastUpdate ?? custodyLost?.lastUpdate ?? null,
    live: custodyGained?.live ?? custodyLost?.live ?? false,
    gainers: custodyHouses(custodyGained, 1),
    losers: custodyHouses(custodyLost, -1),
    unavailableMessage: custodyGained?.unavailableMessage ?? custodyLost?.unavailableMessage ?? null,
  }
}

// The register reports moves as magnitudes and leaves the direction to the
// reading's mode, so the sign is applied here.
function custodyHouses(analysis: SettlementAnalysis | null | undefined, sign: 1 | -1): OverviewCustodyHouse[] {
  if (!analysis) return []
  return analysis.holdings.slice(0, TOP_HOUSE_COUNT).map((holding) => ({
    brokerage: holding.brokerage,
    lotChange: holding.lotChange !== null ? sign * Math.abs(holding.lotChange) : null,
    percentage: holding.percentage,
  }))
}

// Unions the leading houses of both feeds into one row per house, so churn
// (heavy flow, flat custody) and quiet accumulation (the reverse) show up.
function joinHouses(
  flow: OverviewFlow | null,
  custody: OverviewCustody | null,
  lastPrice: number | null,
): OverviewHouse[] {
  const rows = new Map<string, OverviewHouse>()
  const rowFor = (brokerage: string): OverviewHouse => {
    let row = rows.get(brokerage)
    if (!row) {
      row = {
        brokerage,
        flowBoughtLots: null,
        flowSoldLots: null,
        flowNetLots: null,
        flowAveragePrice: null,
        averagePriceVsLast: null,
        custodyLotChange: null,
        custodyShare: null,
      }
      rows.set(brokerage, row)
    }
    return row
  }

  for (const house of flow?.buyers ?? []) {
    const row = rowFor(house.brokerage)
    row.flowBoughtLots = house.netLots
    row.flowAveragePrice = house.averagePrice
  }
  for (const house of flow?.sellers ?? []) {
    const row = rowFor(house.brokerage)
    row.flowSoldLots = house.netLots
    // A house on both sides keeps the VWAP of its larger side.
    if (row.flowAveragePrice === null || house.netLots > (row.flowBoughtLots ?? 0)) {
      row.flowAveragePrice = house.averagePrice
    }
  }
  for (const house of [...(custody?.gainers ?? []), ...(custody?.losers ?? [])]) {
    const row = rowFor(house.brokerage)
    row.custodyLotChange = house.lotChange
    row.custodyShare = house.percentage
  }

  for (const row of rows.values()) {
    if (row.flowBoughtLots !== null || row.flowSoldLots !== null) {
      row.flowNetLots = (row.flowBoughtLots ?? 0) - (row.flowSoldLots ?? 0)
    }
    if (lastPrice !== null && row.flowAveragePrice !== null) {
      row.averagePriceVsLast = round(lastPrice - row.flowAveragePrice)
    }
  }

  return [...rows.values()]
    .sort((left, right) => magnitude(right) - magnitude(left))
    .slice(0, MAX_JOINED_HOUSES)
}

function magnitude(row: OverviewHouse): number {
  return Math.max(Math.abs(row.flowNetLots ?? 0), Math.abs(row.custodyLotChange ?? 0))
}

function historySection(inputs: OverviewDigestInputs): OverviewHistory | null {
  const intradayMode = inputs.mode === "INTRADAY"
  const intraday = intradayMode ? candleSection(inputs.intradayCandles, MAX_INTRADAY_CANDLES) : null
  const daily = candleSection(inputs.dailyCandles, intradayMode ? MAX_CONTEXT_DAILY_CANDLES : MAX_DAILY_CANDLES)
  if (!intraday && !daily) return null
  return { intraday, daily }
}

function candleSection(series: CandleSeries | null | undefined, limit: number): OverviewCandleSeries | null {
  if (!series || series.candles.length === 0) return null
  return {
    interval: series.interval,
    candles: series.candles.slice(-limit).map((candle) => ({
      time: formatCandleTime(candle.timestamp),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    })),
  }
}

// The exchange's own clock, so the model reads session opens and closes where
// they actually happen. sv-SE formats as "YYYY-MM-DD HH:mm:ss".
function formatCandleTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 16)
}

function sumLots(levels: Array<{ lots: number }>): number | null {
  if (levels.length === 0) return null
  return levels.reduce((total, level) => total + level.lots, 0)
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
