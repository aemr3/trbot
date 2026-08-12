import { expect, test } from "bun:test"
import type { Candle } from "../../market/candle.ts"
import type { MarketRuleSnapshot } from "../backtest.ts"
import { createExperimentManifest, type ExperimentRunOptions } from "./experiment.ts"
import { runWalkForwardExperimentInWorker } from "./experiment-worker-client.ts"
import type { ReinforcementReplayEpisode } from "./replay.ts"

test("runs walk-forward validation in a worker and reports progress", async () => {
  const phases: string[] = []

  const result = await runWalkForwardExperimentInWorker({
    ...experimentOptions(),
    onProgress: (progress) => phases.push(progress.phase),
  })

  expect(result.experiment.selectedCandidate).toBe("test")
  expect(phases).toContain("VALIDATING")
})

test("preserves deterministic experiment results across worker runs", async () => {
  const first = await runWalkForwardExperimentInWorker(experimentOptions())
  const second = await runWalkForwardExperimentInWorker(experimentOptions())

  expect(second).toEqual(first)
})

test("cooperatively cancels an active worker experiment", async () => {
  const controller = new AbortController()
  let progressReported = false
  const run = runWalkForwardExperimentInWorker({
    ...experimentOptions(100),
    signal: controller.signal,
    onProgress: () => {
      progressReported = true
      controller.abort()
    },
  })

  await expect(run).rejects.toMatchObject({ name: "AbortError" })
  expect(progressReported).toBe(true)
})

function experimentOptions(epochs = 1): ExperimentRunOptions {
  const episodes = ["2026-08-03", "2026-08-04", "2026-08-05"].map(episode)
  return {
    episodes,
    skippedInstruments: 0,
    manifest: createExperimentManifest({
      requestedStartDate: "2026-08-03",
      cutoffDate: "2026-08-05",
      universe: [{ uid: "future-1", symbol: "F_TEST0826" }],
      epochs,
      seeds: [7],
      candidates: [{
        id: "test",
        configuration: {
          learningRate: 0.02,
          discountFactor: 0.95,
          explorationRate: 0.1,
          actionMargin: 0,
          executionCostMarginMultiplier: 0,
        },
      }],
      protocol: { minimumTrainSessions: 1, validationSessions: 1, holdoutSessions: 1 },
    }),
    policyId: "policy-1",
    now: 1,
  }
}

function episode(sessionDate: string): ReinforcementReplayEpisode {
  return {
    sessionDate,
    candles: candles(sessionDate),
    decisionIndexes: [19],
    identity: { instrumentUid: "future-1", symbol: "F_TEST0826" },
    rules,
    startingBalance: 20_000,
    costs: { slippageBpsPerSide: 0, commissionBpsPerSide: 0 },
  }
}

function candles(sessionDate: string): Candle[] {
  return Array.from({ length: 21 }, (_, index) => ({
    timestamp: Date.parse(`${sessionDate}T09:00:00+03:00`) + index * 10 * 60_000,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: index === 20 ? 101 : 100,
    volume: 1_000,
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
