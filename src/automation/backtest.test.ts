import { expect, test } from "bun:test"
import type { Candle } from "../market/candle.ts"
import {
  buildPortfolioSnapshot,
  buildTradingContext,
  calculateBacktestMetrics,
  completedCandles,
  enforceCollateralBudget,
  simulatePositionDecision,
  type TradingDecision,
  type BacktestDecisionRecord,
  type MarketRuleSnapshot,
} from "./backtest.ts"

const rules: MarketRuleSnapshot = {
  venue: "Borsa Istanbul VIOP",
  capturedAt: 1,
  expiryDate: "31/08/2026",
  contractMultiplier: 100,
  standardEquityContractMultiplier: 100,
  initialCollateral: 5_000,
  previousSettlementPrice: 99,
  lowerPriceLimit: 50,
  upperPriceLimit: 150,
  underlyingEquityPriceMarginPercent: 10,
  equityFutureDailyLimitPercent: 10,
  equityFutureTickSizeBands: [],
  equityDownsideCircuitBreakerPercent: 5,
  marketWideCircuitBreakerPercent: 6,
  marketWideHaltMinutesForEquityDerivatives: 20,
  rulesEffectiveFrom: "2025-09-01",
  caveats: [],
}

test("builds point-in-time context without exposing the next candle", () => {
  const candles = candleSeries(24)
  const context = buildTradingContext(candles, 21, { instrumentUid: "future-1", symbol: "F_TEST0826" }, rules)

  expect(context.candles).toHaveLength(22)
  expect(context.candles[0]?.timestamp).toBe(candles[0]?.timestamp)
  expect(context.candles.at(-1)?.timestamp).toBe(candles[21]?.timestamp)
  expect(context.candles.some((candle) => candle.timestamp === candles[22]?.timestamp)).toBe(false)
  expect(context.indicators.sma20).not.toBeNull()
  expect(context.indicators.rsi14).not.toBeNull()
  expect(context.costs).toEqual({ slippageBpsPerSide: 2, commissionBpsPerSide: 0 })
  expect(context.collateral).toEqual({
    totalBalance: 5_000,
    usedBalance: 0,
    availableBalance: 5_000,
    requiredForOneContract: 5_000,
    usedByThisContract: 0,
    canOpenFromFlat: true,
  })
  expect(context.strategyState).toMatchObject({ startingBalance: 5_000, runningBalance: 5_000, priorPredictions: 0 })
})

test("includes only already-realized strategy outcomes in decision state", () => {
  const context = buildTradingContext(
    candleSeries(24),
    21,
    { instrumentUid: "future-1", symbol: "F_TEST0826" },
    rules,
    {
      startingBalance: 10_000,
      universe: { selectedSymbols: ["F_TEST0826"], selectionThesis: "Strong open", riskFlags: ["Volatile"] },
      priorDecisions: [
        { action: "LONG", confidence: 0.7, netPnl: 120 },
        { action: "FLAT", confidence: 0.4, netPnl: 0 },
      ],
    },
  )

  expect(context.universe?.selectionThesis).toBe("Strong open")
  expect(context.strategyState).toMatchObject({
    startingBalance: 10_000,
    runningBalance: 10_120,
    cumulativeNetPnl: 120,
    priorPredictions: 2,
    priorNonFlatTargets: 1,
    priorPositiveIntervals: 1,
    priorNegativeIntervals: 0,
  })
})

test("keeps only fully completed valid candles", () => {
  const candles = candleSeries(3)
  candles.push({ timestamp: 30 * 60_000, open: 0, high: 1, low: 0, close: 1, volume: 1 })

  expect(completedCandles(candles, 10 * 60_000, 25 * 60_000)).toEqual(candles.slice(0, 2))
})

test("blocks lower-confidence entries that exceed available collateral", () => {
  const candles = flatCandleSeries(20)
  const collateralRules = { ...rules, initialCollateral: 8_000 }
  const portfolio = buildPortfolioSnapshot(candles.at(-1)!.timestamp, 20_000, 0, 0, [])
  const inputs = [
    ["future-1", "F_ONE0826", 0.9],
    ["future-2", "F_TWO0826", 0.8],
    ["future-3", "F_THREE0826", 0.7],
  ] as const
  const decisions = enforceCollateralBudget(portfolio, inputs.map(([instrumentUid, symbol, confidence]) => ({
    context: buildTradingContext(candles, 19, { instrumentUid, symbol }, collateralRules, {
      portfolio,
      startingBalance: 20_000,
    }),
    position: null,
    decision: { instrumentUid, action: "LONG", confidence, thesis: "test", riskFlags: [] },
  })))

  expect(decisions.map((decision) => decision.action)).toEqual(["LONG", "LONG", "FLAT"])
  expect(decisions[2]?.riskFlags[0]).toContain("required 8000.00, available 4000.00")
})

test("opens, holds, and closes a position across bars", () => {
  const candles = flatCandleSeries(20)
  const firstContext = buildTradingContext(candles, 19, { instrumentUid: "future-1", symbol: "F_TEST0826" }, rules)
  const firstNext = { timestamp: 20 * 600_000, open: 100, high: 104, low: 99, close: 103, volume: 10 }
  const base = { confidence: 0.7, thesis: "test", riskFlags: [] }
  const noCosts = { slippageBpsPerSide: 0, commissionBpsPerSide: 0 }

  const opened = simulatePositionDecision(firstContext, { ...base, action: "LONG" }, firstNext, null, noCosts)
  const secondCandles = [...candles, firstNext]
  const secondContext = buildTradingContext(secondCandles, 20, { instrumentUid: "future-1", symbol: "F_TEST0826" }, rules)
  const secondNext = { timestamp: 21 * 600_000, open: 103, high: 106, low: 102, close: 105, volume: 11 }
  const held = simulatePositionDecision(secondContext, { ...base, action: "LONG" }, secondNext, opened.position, noCosts)
  const thirdContext = buildTradingContext([...secondCandles, secondNext], 21, {
    instrumentUid: "future-1",
    symbol: "F_TEST0826",
  }, rules)
  const thirdNext = { timestamp: 22 * 600_000, open: 105, high: 106, low: 103, close: 104, volume: 12 }
  const closed = simulatePositionDecision(thirdContext, { ...base, action: "FLAT" }, thirdNext, held.position, noCosts)

  expect(opened.result).toMatchObject({ transition: "OPEN", netPnl: 300, positionAfter: "LONG", exitPrice: null })
  expect(held.result).toMatchObject({ transition: "HOLD", netPnl: 200, positionAfter: "LONG" })
  expect(closed.result).toMatchObject({ transition: "CLOSE", netPnl: 0, positionAfter: "FLAT", exitPrice: 105 })
  expect(closed.result.closedTrades[0]).toMatchObject({
    holdingMinutes: 20,
    grossPnl: 500,
    costs: 0,
    netPnl: 500,
  })
  expect(opened.result.netPnl + held.result.netPnl + closed.result.netPnl)
    .toBe(closed.result.closedTrades[0]!.netPnl)
  expect(closed.position).toBeNull()
})

test("liquidates a remaining position at the final session close", () => {
  const candles = flatCandleSeries(20)
  const context = buildTradingContext(candles, 19, { instrumentUid: "future-1", symbol: "F_TEST0826" }, rules)
  const next = { timestamp: 20 * 600_000, open: 100, high: 104, low: 99, close: 103, volume: 10 }
  const simulation = simulatePositionDecision(
    context,
    { action: "LONG", confidence: 0.7, thesis: "test", riskFlags: [] },
    next,
    null,
    { slippageBpsPerSide: 0, commissionBpsPerSide: 0 },
    true,
  )

  expect(simulation.position).toBeNull()
  expect(simulation.result).toMatchObject({ sessionClosed: true, positionAfter: "FLAT", netPnl: 300 })
  expect(simulation.result.closedTrades[0]).toMatchObject({ reason: "SESSION_END", netPnl: 300 })
})

test("calculates trade-only hit rate, costs, and absolute drawdown", () => {
  const records = [record("LONG", 100, 1), record("FLAT", 0, 2), record("SHORT", -40, 3), record("LONG", 20, 4)]
  const metrics = calculateBacktestMetrics(records, 1_000)

  expect(metrics).toMatchObject({ predictions: 4, trades: 3, wins: 2, losses: 1, flatSignals: 1 })
  expect(metrics.winRate).toBeCloseTo(2 / 3)
  expect(metrics.netPnl).toBe(80)
  expect(metrics.startBalance).toBe(1_000)
  expect(metrics.endBalance).toBe(1_080)
  expect(metrics.maxDrawdown).toBe(40)
  expect(metrics.profitFactor).toBe(3)
})

test("groups simultaneous ticker outcomes before calculating portfolio drawdown", () => {
  const records = [record("LONG", -100, 1), record("LONG", 150, 1)]
  const metrics = calculateBacktestMetrics(records, 1_000)

  expect(metrics.netPnl).toBe(50)
  expect(metrics.maxDrawdown).toBe(0)
})

function candleSeries(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: index * 10 * 60_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 100 + index,
  }))
}

function flatCandleSeries(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: index * 600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100 + index,
  }))
}

function record(action: TradingDecision["action"], netPnl: number, entryOffset: number): BacktestDecisionRecord {
  const context = buildTradingContext(candleSeries(21), 19, { instrumentUid: "future-1", symbol: "F_TEST0826" }, rules)
  return {
    context,
    decision: { action, confidence: 0.5, thesis: "test", riskFlags: [] },
    result: {
      decisionAt: context.asOf,
      entryAt: context.asOf + entryOffset * 10 * 60_000,
      action,
      confidence: 0.5,
      transition: action === "FLAT" ? "FLAT" : "OPEN",
      positionBefore: "FLAT",
      positionAfter: "FLAT",
      sessionClosed: action !== "FLAT",
      entryPrice: action === "FLAT" ? null : 100,
      exitPrice: action === "FLAT" ? null : 101,
      grossPnl: netPnl,
      costs: 0,
      netPnl,
      returnPercent: netPnl / 100,
      closedTrades: action === "FLAT" ? [] : [{
        side: action,
        entryAt: context.asOf,
        exitAt: context.asOf + entryOffset * 600_000,
        holdingMinutes: entryOffset * 10,
        entryMarketPrice: 100,
        exitMarketPrice: 101,
        entryPrice: 100,
        exitPrice: 101,
        grossPnl: netPnl,
        costs: 0,
        netPnl,
        reason: "SIGNAL",
      }],
    },
  }
}
