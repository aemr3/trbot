import { expect, test } from "bun:test"
import type { DepthBook, DepthTrade } from "./depth.ts"
import { TradeFlowAccumulator } from "./trade-flow.ts"

function trade(overrides: Partial<DepthTrade> & { id: string }): DepthTrade {
  return { price: 100, lots: 10, side: "BUY", buyer: "Alpha", seller: "Beta", ...overrides }
}

function book(trades: DepthTrade[]): DepthBook {
  return {
    symbol: "ASELS",
    bids: [],
    asks: [],
    buyLots: null,
    sellLots: null,
    trades,
    marketClosed: false,
  }
}

test("accumulates per-broker totals and aggressor lots", () => {
  const flow = new TradeFlowAccumulator()
  flow.ingest(
    book([
      trade({ id: "1", lots: 100, side: "BUY", buyer: "Alpha", seller: "Beta" }),
      trade({ id: "2", lots: 40, side: "SELL", buyer: "Beta", seller: "Alpha" }),
      trade({ id: "3", lots: 25, side: "BUY", buyer: "Gamma", seller: "Beta" }),
    ]),
  )

  const summary = flow.snapshot()
  expect(summary.tradeCount).toBe(3)
  expect(summary.aggressorBuyLots).toBe(125)
  expect(summary.aggressorSellLots).toBe(40)
  expect(summary.brokers[0]).toEqual({ brokerage: "Beta", boughtLots: 40, soldLots: 125, netLots: -85 })
  expect(summary.brokers[1]).toEqual({ brokerage: "Alpha", boughtLots: 100, soldLots: 40, netLots: 60 })
  expect(summary.brokers[2]).toEqual({ brokerage: "Gamma", boughtLots: 25, soldLots: 0, netLots: 25 })
})

test("dedupes trades that reappear across overlapping tape windows", () => {
  const flow = new TradeFlowAccumulator()
  const first = trade({ id: "1", lots: 100 })
  flow.ingest(book([first]))
  flow.ingest(book([trade({ id: "2", lots: 30 }), first]))

  const summary = flow.snapshot()
  expect(summary.tradeCount).toBe(2)
  expect(summary.aggressorBuyLots).toBe(130)
  expect(summary.brokers[0]?.boughtLots).toBe(130)
})

test("skips broker totals when the tape omits a counterparty", () => {
  const flow = new TradeFlowAccumulator()
  flow.ingest(book([trade({ id: "1", lots: 50, buyer: null, seller: "Beta" })]))

  const summary = flow.snapshot()
  expect(summary.tradeCount).toBe(1)
  expect(summary.brokers).toEqual([{ brokerage: "Beta", boughtLots: 0, soldLots: 50, netLots: -50 }])
})

test("reset starts the session over", () => {
  const flow = new TradeFlowAccumulator()
  flow.ingest(book([trade({ id: "1", lots: 100 })]))
  flow.reset()

  expect(flow.snapshot()).toEqual({
    tradeCount: 0,
    aggressorBuyLots: 0,
    aggressorSellLots: 0,
    brokers: [],
  })

  // The same id counts again after a reset: it belongs to the new session.
  flow.ingest(book([trade({ id: "1", lots: 20 })]))
  expect(flow.snapshot().tradeCount).toBe(1)
})
