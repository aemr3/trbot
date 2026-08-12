import { expect, test } from "bun:test"
import type { CandleSeries } from "../../market/candle.ts"
import { DEFAULT_INTERVALS_BY_RANGE } from "../../market/candle.ts"
import type { BacktestCandleSource } from "../../market/candle-history.ts"
import type { ViopInstrument, ViopInstrumentSource } from "../../market/instrument.ts"
import type { ViopOrderSource } from "../../trading/order.ts"
import type { ReinforcementExperimentArtifact, ReinforcementExperimentStore } from "./experiment-store.ts"
import type { ReinforcementPolicyArtifact, ReinforcementPolicyStore } from "./store.ts"
import { HistoricalReinforcementBacktestRunner, latestExposedHoldoutDate } from "./backtest-runner.ts"

const instrument: ViopInstrument = {
  uid: "future-1",
  symbol: "F_TEST0826",
  displayName: "TEST",
  underlyingSymbol: "TEST",
  lastPrice: 100,
  changePercent: 0,
  volume: 1_000,
  currency: "TRY",
}

test("builds chronological reinforcement episodes directly from a historical date range", async () => {
  const captured: { range: [string, string] | null } = {
    range: null,
  }
  const phases: string[] = []
  let historyLoads = 0
  const candles: BacktestCandleSource = {
    async loadCandles() { return series() },
    async loadRange(_instrument, options) {
      historyLoads++
      captured.range = [options.startDate, options.endDate]
      return series()
    },
  }
  const instruments: ViopInstrumentSource = {
    async listInstruments() { return [instrument] },
    async loadContractDetails() {
      return {
        initialCollateral: 2_000,
        leverage: 5,
        contractSize: 100,
        expiryDate: "31/08/2026",
        sessionHigh: null,
        sessionLow: null,
        settlementPrice: null,
        previousSettlementPrice: 100,
        volume: null,
        openInterest: null,
      }
    },
  }
  const orderPreparation: Pick<ViopOrderSource, "prepareOrder"> = {
    async prepareOrder() {
      return {
        lowerLimit: 90,
        upperLimit: 110,
        bid: 99.95,
        ask: 100.05,
        lastPrice: 100,
        contractSize: 100,
        initialCollateral: 2_000,
        priceScale: 2,
        availableCollateral: 20_000,
        currentPositionQuantity: 0,
        positionIntent: "BUY_TO_OPEN",
      }
    },
  }
  const runner = new HistoricalReinforcementBacktestRunner({
    candles,
    instruments,
    orderPreparation,
    now: () => Date.parse("2026-08-06T20:00:00+03:00"),
    lookbackDays: 3,
    epochs: 1,
    seeds: [7],
    candidates: [{ id: "test", configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0 } }],
    protocol: { minimumTrainSessions: 1, validationSessions: 1, holdoutSessions: 1 },
    createId: () => "policy-1",
    policies: memoryPolicyStore(),
    experiments: memoryExperimentStore(),
  })

  const result = await runner.run([instrument], {
    onProgress: (progress) => phases.push(progress.phase),
  })

  expect(captured.range).toEqual(["2026-08-03", "2026-08-06"])
  expect(result).toMatchObject({ sessionDates: ["2026-08-03", "2026-08-04", "2026-08-05"], instruments: 1, episodes: 3 })
  expect(result.experiment).toMatchObject({ selectedCandidate: "test", holdoutDates: ["2026-08-05"] })
  expect(result.experiment.verdict).toBe("REJECTED")
  expect(result.experiment.holdoutStatus).toBe("VALIDATION_REJECTED")
  expect(result.experiment.test).toBeNull()
  expect(result.experiment.policyId).toBeNull()
  expect(result.artifact).toBeNull()
  expect(phases).toContain("LOADING_HISTORY")
  expect(phases).toContain("PREPARING_DATASET")
  expect(phases).toContain("VALIDATING")
  expect(phases).not.toContain("TESTING")

  const cached = await runner.run([instrument], {})
  expect(cached.cached).toBe(true)
  expect(historyLoads).toBe(1)
})

test("tracks only holdout dates that prior experiments actually evaluated", () => {
  const evaluated = experimentArtifact("EVALUATED", ["2026-08-07", "2026-08-10"])
  const rejected = experimentArtifact("VALIDATION_REJECTED", ["2026-08-11"])

  expect(latestExposedHoldoutDate([evaluated, rejected])).toBe("2026-08-10")
})

function series(): CandleSeries {
  const dates = ["2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05"]
  const candles = dates.flatMap((date, dateIndex) => Array.from({ length: dateIndex === 0 ? 20 : 12 }, (_, index) => ({
    timestamp: Date.parse(`${date}T09:30:00+03:00`) + index * 10 * 60_000,
    open: 100 + index * 0.02,
    high: 100.2 + index * 0.02,
    low: 99.8 + index * 0.02,
    close: 100.1 + index * 0.02,
    volume: 1_000 + index,
  })))
  return {
    instrumentUid: instrument.uid,
    range: "INTRADAY",
    interval: "MIN_10",
    candles,
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    intervalMs: 10 * 60_000,
    currency: "TRY",
  }
}

function memoryPolicyStore(): ReinforcementPolicyStore {
  const values = new Map<string, ReinforcementPolicyArtifact>()
  return {
    async put(value) { values.set(value.id, value) },
    async get(id) { return values.get(id) ?? null },
    async latest() { return [...values.values()].at(-1) ?? null },
    async list() { return [...values.values()] },
    async delete(id) { return values.delete(id) },
  }
}

function memoryExperimentStore(): ReinforcementExperimentStore {
  const values = new Map<string, ReinforcementExperimentArtifact>()
  return {
    async put(value) { values.set(value.id, value) },
    async get(id) { return values.get(id) ?? null },
    async latest() { return [...values.values()].at(-1) ?? null },
    async list() { return [...values.values()] },
    async delete(id) { return values.delete(id) },
  }
}

function experimentArtifact(
  holdoutStatus: ReinforcementExperimentArtifact["holdoutStatus"],
  holdoutDates: string[],
): ReinforcementExperimentArtifact {
  const evaluation = { sessions: 0, instruments: 0, decisions: 0, trades: 0, wins: 0, losses: 0, profitableSessions: 0, netPnl: 0, averageSessionReturnPercent: 0, worstSessionDrawdown: 0 }
  const aggregate = { runs: 0, profitableRuns: 0, meanNetPnl: 0, medianNetPnl: 0, meanReturnPercent: 0, meanTrades: 0, meanWinRatePercent: 0, worstDrawdown: 0 }
  return {
    id: holdoutStatus ?? "legacy",
    manifest: {
      version: "viop-walk-forward-v5",
      featureVersion: "viop-linear-q-v2",
      featureNames: [],
      requestedStartDate: "2026-06-01",
      cutoffDate: "2026-08-11",
      universe: [],
      costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 },
      epochs: 1,
      seeds: [1],
      candidates: [],
      protocol: { minimumTrainSessions: 1, validationSessions: 1, holdoutSessions: 1 },
    },
    eligibleDates: [],
    windows: [],
    candidates: [],
    selectedCandidate: "none",
    validation: aggregate,
    validationBaselines: [],
    verdict: "REJECTED",
    rejectionReasons: [],
    holdoutDates,
    holdoutStatus,
    testRuns: holdoutStatus === "EVALUATED" ? [{ seed: 1, evaluation, diagnostics: emptyDiagnostics() }] : [],
    test: null,
    diagnostics: null,
    baselines: [],
    policyId: null,
    instruments: 0,
    episodes: 0,
    skippedInstruments: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function emptyDiagnostics() {
  return { decisions: 0, actions: { flat: 0, long: 0, short: 0 }, turnover: 0, trades: 0, averageHoldingMinutes: 0, grossPnl: 0, costs: 0, netPnl: 0, longPnl: 0, shortPnl: 0, byTicker: [] }
}
