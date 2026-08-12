import { expect, test } from "bun:test"
import type { Candle } from "../../market/candle.ts"
import type { MarketRuleSnapshot } from "../backtest.ts"
import { LinearQPolicy } from "./linear-q-policy.ts"
import { evaluatePortfolioSessions, replayPortfolioSession } from "./portfolio-replay.ts"
import type { ReinforcementReplayEpisode } from "./replay.ts"
import { REINFORCEMENT_FEATURE_NAMES } from "./state.ts"

const rules: MarketRuleSnapshot = {
  venue: "Borsa Istanbul VIOP",
  capturedAt: 1,
  expiryDate: "31/08/2026",
  contractMultiplier: 100,
  standardEquityContractMultiplier: 100,
  initialCollateral: 12_000,
  previousSettlementPrice: 100,
  lowerPriceLimit: 90,
  upperPriceLimit: 110,
  underlyingEquityPriceMarginPercent: 10,
  equityFutureDailyLimitPercent: 10,
  equityFutureTickSizeBands: [],
  equityDownsideCircuitBreakerPercent: 5,
  marketWideCircuitBreakerPercent: 6,
  marketWideHaltMinutesForEquityDerivatives: 20,
  rulesEffectiveFrom: "2025-09-01",
  caveats: [],
}

test("replays simultaneous tickers against one collateral-constrained portfolio", () => {
  const policy = longPolicy()
  const result = replayPortfolioSession(policy, [episode("future-1", "F_ONE0826"), episode("future-2", "F_TWO0826")])
  const decisions = result.tickers.map((ticker) => ticker.records[0]!.decision)

  expect(decisions.map((decision) => decision.action)).toEqual(["LONG", "FLAT"])
  expect(decisions[1]?.riskFlags[0]).toContain("Collateral blocked")
  expect(result.metrics).toMatchObject({ startBalance: 20_000, endBalance: 20_100, trades: 1, netPnl: 100 })
  expect(result.endingPortfolio).toMatchObject({ equity: 20_100, reservedCollateral: 0, availableBalance: 20_100 })
})

test("keeps portfolio evaluation frozen across multiple tickers", () => {
  const policy = longPolicy()
  const snapshot = policy.snapshot()

  const results = evaluatePortfolioSessions(policy, [episode("future-1", "F_ONE0826"), episode("future-2", "F_TWO0826")])

  expect(results).toHaveLength(1)
  expect(policy.snapshot()).toEqual(snapshot)
})

test("maintains prior decision state incrementally between prepared events", () => {
  const input = episode("future-1", "F_ONE0826")
  input.candles.push({
    timestamp: input.candles[20]!.timestamp + 10 * 60_000,
    open: 101,
    high: 102.2,
    low: 100.8,
    close: 102,
    volume: 2_000,
  })
  input.decisionIndexes = [19, 20]

  const result = replayPortfolioSession(longPolicy(), [input])

  expect(result.records[1]!.context.strategyState).toMatchObject({
    runningBalance: 20_100,
    cumulativeNetPnl: 100,
    priorPredictions: 1,
    priorNonFlatTargets: 1,
    priorPositiveIntervals: 1,
    priorNegativeIntervals: 0,
  })
  expect(result.records[1]!.context.strategyState.recentDecisions).toHaveLength(1)
})

test("applies turnover penalty only to training reward without changing execution P&L", () => {
  const unpenalized = replayPortfolioSession(longPolicy(), [episode("future-1", "F_ONE0826")], {
    training: true,
  })
  const penalized = replayPortfolioSession(longPolicy(), [episode("future-1", "F_ONE0826")], {
    training: true,
    trainingTurnoverPenaltyBps: 10,
  })
  const evaluated = replayPortfolioSession(longPolicy(), [episode("future-1", "F_ONE0826")], {
    trainingTurnoverPenaltyBps: 10,
  })

  expect(penalized.tickers[0]!.steps[0]!.reward).toBeLessThan(unpenalized.tickers[0]!.steps[0]!.reward)
  expect(penalized.metrics).toEqual(unpenalized.metrics)
  expect(evaluated.tickers[0]!.steps[0]!.reward).toBe(unpenalized.tickers[0]!.steps[0]!.reward)
})

test("uses instrument execution costs to reject uneconomic position changes", () => {
  const input = episode("future-1", "F_ONE0826")
  input.costs = { slippageBpsPerSide: 2, commissionBpsPerSide: 0 }
  const ungated = replayPortfolioSession(marginalLongPolicy(0), [input])
  const gated = replayPortfolioSession(marginalLongPolicy(2), [input])

  expect(ungated.records[0]!.decision.action).toBe("LONG")
  expect(gated.records[0]!.decision.action).toBe("FLAT")
})

test("penalizes actual execution costs only in the training objective", () => {
  const input = episode("future-1", "F_ONE0826")
  input.costs = { slippageBpsPerSide: 2, commissionBpsPerSide: 0 }
  const unpenalized = replayPortfolioSession(longPolicy(), [input], { training: true })
  const penalized = replayPortfolioSession(longPolicy(), [input], {
    training: true,
    trainingCostPenaltyMultiplier: 2,
  })

  expect(penalized.tickers[0]!.steps[0]!.reward).toBeLessThan(unpenalized.tickers[0]!.steps[0]!.reward)
  expect(penalized.metrics).toEqual(unpenalized.metrics)
})

function longPolicy(): LinearQPolicy {
  const zeros = () => Array.from({ length: REINFORCEMENT_FEATURE_NAMES.length }, () => 0)
  return new LinearQPolicy(REINFORCEMENT_FEATURE_NAMES.length, { explorationRate: 0 }, {
    featureCount: REINFORCEMENT_FEATURE_NAMES.length,
    biases: { FLAT: 0, LONG: 1, SHORT: 0 },
    weights: { FLAT: zeros(), LONG: zeros(), SHORT: zeros() },
  })
}

function marginalLongPolicy(executionCostMarginMultiplier: number): LinearQPolicy {
  const zeros = () => Array.from({ length: REINFORCEMENT_FEATURE_NAMES.length }, () => 0)
  return new LinearQPolicy(REINFORCEMENT_FEATURE_NAMES.length, { executionCostMarginMultiplier }, {
    featureCount: REINFORCEMENT_FEATURE_NAMES.length,
    biases: { FLAT: 0, LONG: 0.0001, SHORT: -1 },
    weights: { FLAT: zeros(), LONG: zeros(), SHORT: zeros() },
  })
}

function episode(instrumentUid: string, symbol: string): ReinforcementReplayEpisode {
  const candles = flatCandles(21)
  candles[20] = {
    timestamp: candles[19]!.timestamp + 10 * 60_000,
    open: 100,
    high: 101.2,
    low: 99.9,
    close: 101,
    volume: 2_000,
  }
  return {
    sessionDate: "2026-08-10",
    candles,
    decisionIndexes: [19],
    identity: { instrumentUid, symbol },
    rules,
    startingBalance: 20_000,
    costs: { slippageBpsPerSide: 0, commissionBpsPerSide: 0 },
  }
}

function flatCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: Date.parse("2026-08-10T09:00:00+03:00") + index * 10 * 60_000,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1_000,
  }))
}
