import { expect, test } from "bun:test"
import type { BrokerageDistribution, BrokerageShare } from "./brokerage.ts"
import type { DepthBook } from "./depth.ts"
import { buildOverviewDigest, isSameDigest } from "./overview.ts"
import type { SettlementAnalysis, SettlementHolding } from "./settlement.ts"
import type { CandleInterval } from "./candle.ts"

// The digest is priced on the underlying; the contract trades four lira over it.
const INSTRUMENT = {
  symbol: "ASELS",
  displayName: "ASELS Aug Future",
  lastPrice: 390,
  contractSymbol: "F_ASELS0826",
  contractLastPrice: 394,
}

function share(brokerage: string, netLots: number, averagePrice: number, percentage = 10): BrokerageShare {
  return { brokerage, netLots, averagePrice, percentage }
}

function distribution(side: BrokerageDistribution["side"], shares: BrokerageShare[]): BrokerageDistribution {
  return {
    side,
    shares,
    topCount: 3,
    topPercentage: 60,
    topLots: 1000,
    otherLots: 400,
    lastUpdate: "14:30",
    live: true,
    presets: [],
    availableDates: [],
  }
}

function holding(brokerage: string, lotChange: number, percentage = 20): SettlementHolding {
  return { brokerage, percentage, percentageChange: 5, lotChange, totalLot: null }
}

function settlement(mode: SettlementAnalysis["mode"], holdings: SettlementHolding[]): SettlementAnalysis {
  return {
    mode,
    holdings,
    topCount: 3,
    topPercentage: 70,
    topLots: 2000,
    otherLots: 500,
    lastUpdate: "2026-08-15",
    live: false,
    presets: [],
    availableDates: [],
    unavailableMessage: null,
  }
}

function depthBook(overrides: Partial<DepthBook> = {}): DepthBook {
  return {
    symbol: "ASELS",
    bids: [{ price: 389.75, lots: 300, orderCount: 5 }],
    asks: [{ price: 390.25, lots: 100, orderCount: 3 }],
    buyLots: 3000,
    sellLots: 1000,
    trades: [],
    marketClosed: false,
    ...overrides,
  }
}

test("summarizes the book with spread and bid share", () => {
  const digest = buildOverviewDigest({ mode: "INTRADAY", instrument: INSTRUMENT, book: depthBook(), range: { start: null, end: null } })

  expect(digest.book).toEqual({
    bestBid: 389.75,
    bestAsk: 390.25,
    spread: 0.5,
    bidLots: 3000,
    askLots: 1000,
    bidShare: 0.75,
    marketClosed: false,
  })
})

test("falls back to ladder sums when the book totals are missing", () => {
  const digest = buildOverviewDigest({
    mode: "INTRADAY",
    instrument: INSTRUMENT,
    book: depthBook({ buyLots: null, sellLots: null }),
    range: { start: null, end: null },
  })

  expect(digest.book?.bidLots).toBe(300)
  expect(digest.book?.askLots).toBe(100)
})

test("prices the reading on the underlying and reports the contract's basis", () => {
  const digest = buildOverviewDigest({
    mode: "DAILY",
    instrument: INSTRUMENT,
    buyerFlow: distribution("BUYER", [share("Alpha", 500, 388)]),
    range: { start: null, end: null },
  })

  expect(digest.instrument.basis).toBe(4)
  // Alpha's VWAP is an underlying VWAP, so it is two lira onside — not six. The
  // contract's premium must not leak into the comparison.
  expect(digest.houses[0]?.averagePriceVsLast).toBe(2)
})

test("leaves the basis unknown when either price is missing", () => {
  const digest = buildOverviewDigest({
    mode: "DAILY",
    instrument: { ...INSTRUMENT, lastPrice: null },
    range: { start: null, end: null },
  })

  expect(digest.instrument.basis).toBeNull()
  expect(digest.instrument.contractLastPrice).toBe(394)
})

test("joins flow and custody by house and signs custody moves", () => {
  const digest = buildOverviewDigest({
    mode: "DAILY",
    instrument: INSTRUMENT,
    buyerFlow: distribution("BUYER", [share("Alpha", 500, 388), share("Beta", 200, 389)]),
    sellerFlow: distribution("SELLER", [share("Beta", 350, 391)]),
    custodyGained: settlement("GAINED", [holding("Alpha", 450)]),
    custodyLost: settlement("LOST", [holding("Gamma", 120)]),
    range: { start: null, end: null },
  })

  const alpha = digest.houses.find((house) => house.brokerage === "Alpha")
  // Bought heavily and custody grew: real accumulation, VWAP under the last price.
  expect(alpha).toMatchObject({ flowNetLots: 500, flowAveragePrice: 388, custodyLotChange: 450 })
  expect(alpha?.averagePriceVsLast).toBe(2)

  const beta = digest.houses.find((house) => house.brokerage === "Beta")
  // On both sides: net flow subtracts, the VWAP follows the larger (sell) side.
  expect(beta).toMatchObject({ flowNetLots: -150, flowAveragePrice: 391, custodyLotChange: null })

  const gamma = digest.houses.find((house) => house.brokerage === "Gamma")
  // Register-only house: custody move is negative on the LOST reading.
  expect(gamma).toMatchObject({ flowNetLots: null, custodyLotChange: -120, custodyShare: 20 })
})

test("scopes the sections to the reading's horizon", () => {
  const inputs = {
    instrument: INSTRUMENT,
    book: depthBook(),
    buyerFlow: distribution("BUYER", [share("Alpha", 500, 388)]),
    custodyGained: settlement("GAINED", [holding("Alpha", 450)]),
    range: { start: null, end: null },
  }

  // The lagged register stays out of the live reading…
  const intraday = buildOverviewDigest({ ...inputs, mode: "INTRADAY" })
  expect(intraday.book).not.toBeNull()
  expect(intraday.custody).toBeNull()

  // …and the live book stays out of the standing one.
  const daily = buildOverviewDigest({ ...inputs, mode: "DAILY" })
  expect(daily.book).toBeNull()
  expect(daily.custody).not.toBeNull()
})

test("keeps sections null when their feed is missing", () => {
  const digest = buildOverviewDigest({ mode: "DAILY", instrument: INSTRUMENT, range: { start: null, end: null } })

  expect(digest.book).toBeNull()
  expect(digest.tape).toBeNull()
  expect(digest.flow).toBeNull()
  expect(digest.custody).toBeNull()
  expect(digest.houses).toEqual([])
  expect(digest.history).toBeNull()
})

test("carries both price-history timeframes in exchange-local time", () => {
  const series = (interval: CandleInterval, count: number) => ({
    instrumentUid: "u1",
    range: "INTRADAY" as const,
    interval,
    // 2026-08-14 11:00 UTC = 14:00 in Istanbul, one candle per minute.
    candles: Array.from({ length: count }, (_, index) => ({
      timestamp: Date.UTC(2026, 7, 14, 11, index),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 10 * index,
    })),
    availableIntervalsByRange: { INTRADAY: [], WEEK: [], MONTH: [], THREE_MONTH: [], YEAR: [], FIVE_YEAR: [], ALL: [] },
    intervalMs: 60_000,
    currency: "TRY",
  })

  const digest = buildOverviewDigest({
    mode: "INTRADAY",
    instrument: INSTRUMENT,
    intradayCandles: series("MIN_15", 70),
    dailyCandles: series("DAY_1", 3),
    range: { start: null, end: null },
  })

  // Intraday is capped to the newest candles; dailies pass through whole.
  expect(digest.history?.intraday?.candles).toHaveLength(60)
  expect(digest.history?.intraday?.interval).toBe("MIN_15")
  expect(digest.history?.daily?.candles).toHaveLength(3)
  expect(digest.history?.daily?.candles[0]).toEqual({
    time: "2026-08-14 14:00",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 0,
  })
})

test("labels the range and carries custody staleness through", () => {
  const digest = buildOverviewDigest({
    mode: "DAILY",
    instrument: INSTRUMENT,
    buyerFlow: distribution("BUYER", [share("Alpha", 500, 388)]),
    custodyGained: {
      ...settlement("GAINED", []),
      unavailableMessage: "Register not yet published",
    },
    range: { start: "2026-08-12", end: "2026-08-14" },
  })

  expect(digest.flow?.rangeLabel).toBe("12 – 14 Aug")
  expect(digest.custody?.lastUpdate).toBe("2026-08-15")
  expect(digest.custody?.unavailableMessage).toBe("Register not yet published")
})

test("digest equality tracks content, not identity", () => {
  const inputs = {
    mode: "INTRADAY" as const,
    instrument: INSTRUMENT,
    buyerFlow: distribution("BUYER", [share("Alpha", 500, 388)]),
    range: { start: null, end: null },
  }
  expect(isSameDigest(buildOverviewDigest(inputs), buildOverviewDigest(inputs))).toBeTrue()

  const changed = buildOverviewDigest({
    ...inputs,
    buyerFlow: distribution("BUYER", [share("Alpha", 501, 388)]),
  })
  expect(isSameDigest(buildOverviewDigest(inputs), changed)).toBeFalse()
})
