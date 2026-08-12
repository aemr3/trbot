import { expect, test } from "bun:test"
import type { Candle } from "../../market/candle.ts"
import { buildTradingContext, type MarketRuleSnapshot } from "../backtest.ts"
import { extractReinforcementState, REINFORCEMENT_FEATURE_NAMES } from "./state.ts"

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

test("extracts a bounded fixed-size state without future candle leakage", () => {
  const original = candles(24)
  const changedFuture = original.map((candle) => ({ ...candle }))
  changedFuture[22] = { ...changedFuture[22]!, open: 500, high: 600, low: 400, close: 550, volume: 1_000_000 }
  const identity = { instrumentUid: "future-1", symbol: "F_TEST0826" }
  const firstContext = buildTradingContext(original, 21, identity, rules, { startingBalance: 20_000 })
  const changedContext = buildTradingContext(changedFuture, 21, identity, rules, { startingBalance: 20_000 })
  const first = extractReinforcementState(firstContext, null)
  const changed = extractReinforcementState(changedContext, null)

  expect(first.values).toEqual(changed.values)
  expect(first.values).toHaveLength(REINFORCEMENT_FEATURE_NAMES.length)
  expect(first.values.every((value) => Number.isFinite(value) && value >= -1 && value <= 1)).toBe(true)
})

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: Date.parse("2026-08-10T10:00:00+03:00") + index * 10 * 60_000,
    open: 100 + index * 0.1,
    high: 100.3 + index * 0.1,
    low: 99.8 + index * 0.1,
    close: 100.2 + index * 0.1,
    volume: 1_000 + index * 10,
  }))
}
