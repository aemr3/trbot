import { expect, test } from "bun:test"
import type { Candle } from "../../market/candle.ts"
import {
  buildPortfolioSnapshot,
  buildTradingContext,
  buildTradingContextFromSnapshot,
  type MarketRuleSnapshot,
} from "../backtest.ts"
import {
  filterPreparedReplayDates,
  prepareReplayDataset,
} from "./prepared-replay.ts"
import type { ReinforcementReplayEpisode } from "./replay.ts"

test("materializes the same context from a prepared point-in-time market snapshot", () => {
  const input = episode("2026-08-10")
  const prepared = prepareReplayDataset([input]).episodes[0]!
  const portfolio = buildPortfolioSnapshot(input.candles[19]!.timestamp, 20_000, 150, 100, [])
  const state = {
    startingBalance: 20_000,
    portfolio,
    universe: null,
    priorDecisions: [{ action: "LONG" as const, confidence: 0.8, netPnl: 150 }],
  }

  const direct = buildTradingContext(input.candles, 19, input.identity, rules, state, input.costs)
  const cached = buildTradingContextFromSnapshot(prepared.events[0]!.market, input.identity, rules, state, input.costs)

  expect(cached).toEqual(direct)
})

test("prepared features cannot observe candles after the decision", () => {
  const original = episode("2026-08-10")
  const changed = structuredClone(original)
  changed.candles[20] = { ...changed.candles[20]!, close: 9_999, high: 9_999 }
  changed.candles[21] = { ...changed.candles[21]!, close: 8_888, high: 8_888 }

  const originalEvent = prepareReplayDataset([original]).episodes[0]!.events[0]!
  const changedEvent = prepareReplayDataset([changed]).episodes[0]!.events[0]!

  expect(changedEvent.market).toEqual(originalEvent.market)
  expect(changedEvent.nextCandle).not.toEqual(originalEvent.nextCandle)
})

test("prepares each decision once and reuses it across date partitions", () => {
  const inputs = [episode("2026-08-10"), episode("2026-08-11")]
  const prepared = prepareReplayDataset(inputs)
  const filtered = filterPreparedReplayDates(prepared, ["2026-08-11"])

  expect(prepared.episodes.reduce((total, item) => total + item.events.length, 0)).toBe(2)
  expect(filtered[0]).toBe(prepared.sessions[1])
  expect(filtered[0]!.episodes[0]!.events[0]).toBe(prepared.sessions[1]!.episodes[0]!.events[0])
})

function episode(sessionDate: string): ReinforcementReplayEpisode {
  return {
    sessionDate,
    candles: candles(sessionDate),
    decisionIndexes: [19],
    identity: { instrumentUid: `future-${sessionDate}`, symbol: `F_${sessionDate}` },
    rules,
    startingBalance: 20_000,
    costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 },
  }
}

function candles(sessionDate: string): Candle[] {
  return Array.from({ length: 22 }, (_, index) => ({
    timestamp: Date.parse(`${sessionDate}T09:00:00+03:00`) + index * 10 * 60_000,
    open: 100 + index * 0.01,
    high: 100.2 + index * 0.01,
    low: 99.8 + index * 0.01,
    close: 100.1 + index * 0.01,
    volume: 1_000 + index,
  }))
}

const rules: MarketRuleSnapshot = {
  venue: "Borsa Istanbul VIOP",
  capturedAt: 1,
  expiryDate: "31/08/2026",
  contractMultiplier: 100,
  standardEquityContractMultiplier: 100,
  initialCollateral: 2_000,
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
