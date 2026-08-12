import type { ViopContractDetails } from "../market/instrument.ts"
import type { ViopOrderPreparation } from "../trading/order.ts"
import type { MarketRuleSnapshot } from "./backtest.ts"

export function createViopRuleSnapshot(
  details: ViopContractDetails | null,
  preparation: ViopOrderPreparation | null,
  capturedAt: number,
): MarketRuleSnapshot {
  const contractMultiplier = positiveFinite(preparation?.contractSize)
    ?? positiveFinite(details?.contractSize)
  if (contractMultiplier === null) throw new Error("Contract multiplier is unavailable for this VIOP contract")

  return {
    venue: "Borsa Istanbul VIOP",
    capturedAt,
    expiryDate: details?.expiryDate ?? null,
    contractMultiplier,
    standardEquityContractMultiplier: 100,
    initialCollateral: positiveFinite(preparation?.initialCollateral) ?? positiveFinite(details?.initialCollateral),
    previousSettlementPrice: positiveFinite(details?.previousSettlementPrice),
    lowerPriceLimit: positiveFinite(preparation?.lowerLimit),
    upperPriceLimit: positiveFinite(preparation?.upperLimit),
    underlyingEquityPriceMarginPercent: 10,
    equityFutureDailyLimitPercent: 10,
    equityFutureTickSizeBands: [
      { minimum: 0.01, maximum: 99.99, tick: 0.01 },
      { minimum: 100, maximum: 499.99, tick: 0.05 },
      { minimum: 500, maximum: 999.99, tick: 0.1 },
      { minimum: 1_000, maximum: 2_499.99, tick: 0.25 },
      { minimum: 2_500, maximum: null, tick: 0.5 },
    ],
    equityDownsideCircuitBreakerPercent: 5,
    marketWideCircuitBreakerPercent: 6,
    marketWideHaltMinutesForEquityDerivatives: 20,
    rulesEffectiveFrom: "2025-09-01",
    caveats: [
      "Exchange-provided contract multiplier and live price limits override standard product rules.",
      "The 5% downside circuit breaker applies to the underlying equity; OHLC candles do not expose its live state.",
      "A 6% BIST 100 decline triggers the market-wide breaker and pauses equity and equity-index VIOP contracts.",
      "Standard equity futures represent 100 shares, but corporate actions can create non-standard multipliers.",
      "Equity futures currently use a 10% daily price limit; exact rounded limits come from the live order preparation.",
      "The 10% underlying-equity price margin and tiered tick bands are equity-product rules, not generic rules for every VIOP product.",
    ],
  }
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}
