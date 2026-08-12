import { expect, test } from "bun:test"
import type { ReinforcementExperimentArtifact } from "../automation/reinforcement/experiment-store.ts"
import { openDatabase } from "./client.ts"
import { DrizzleReinforcementExperimentStore } from "./reinforcement-experiment-store.ts"
import { DrizzleReinforcementPolicyStore } from "./reinforcement-policy-store.ts"

test("persists a reproducible experiment and deletes its selected policy", async () => {
  const connection = await openDatabase(":memory:")
  const policies = new DrizzleReinforcementPolicyStore(connection.db)
  const experiments = new DrizzleReinforcementExperimentStore(connection.db)
  await policies.put(policy())
  await experiments.put(experiment())

  expect(await experiments.get("experiment-1")).toEqual(experiment())
  expect(await experiments.latest()).toEqual(experiment())
  expect(await experiments.list()).toEqual([experiment()])
  expect(await experiments.delete("experiment-1")).toBe(true)
  expect(await policies.get("policy-1")).toBeNull()
  connection.close()
})

test("persists a rejected experiment without creating a policy", async () => {
  const connection = await openDatabase(":memory:")
  const experiments = new DrizzleReinforcementExperimentStore(connection.db)
  const rejected: ReinforcementExperimentArtifact = {
    ...experiment(),
    id: "rejected-1",
    verdict: "REJECTED",
    rejectionReasons: ["Validation mean P&L is not positive"],
    policyId: null,
  }

  await experiments.put(rejected)

  expect(await experiments.get(rejected.id)).toEqual(rejected)
  expect(await experiments.delete(rejected.id)).toBe(true)
  connection.close()
})

function experiment(): ReinforcementExperimentArtifact {
  const evaluation = { sessions: 1, instruments: 1, decisions: 1, trades: 1, wins: 1, losses: 0, profitableSessions: 1, netPnl: 1, averageSessionReturnPercent: 0.01, worstSessionDrawdown: 0 }
  const aggregate = { runs: 1, profitableRuns: 1, meanNetPnl: 1, medianNetPnl: 1, meanReturnPercent: 0.01, meanTrades: 1, meanWinRatePercent: 100, worstDrawdown: 0 }
  return {
    id: "experiment-1",
    manifest: {
      version: "viop-walk-forward-v1", featureVersion: "viop-linear-q-v2", featureNames: ["return_1"], requestedStartDate: "2026-01-01", cutoffDate: "2026-08-11",
      universe: [{ uid: "u1", symbol: "F_TEST0826" }], costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 }, epochs: 1, seeds: [1],
      candidates: [{ id: "one", configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0 } }],
      protocol: { minimumTrainSessions: 1, validationSessions: 1, holdoutSessions: 1 },
    },
    eligibleDates: ["2026-08-07", "2026-08-10", "2026-08-11"], windows: [{ train: ["2026-08-07"], validation: ["2026-08-10"] }],
    candidates: [{ id: "one", validation: aggregate }], selectedCandidate: "one", validation: aggregate,
    validationBaselines: [{ id: "flat", label: "Always flat", evaluation: aggregate }], verdict: "ACCEPTED", rejectionReasons: [], holdoutDates: ["2026-08-11"], holdoutStatus: "EVALUATED",
    testRuns: [{ seed: 1, evaluation, diagnostics: runDiagnostics() }], test: aggregate, diagnostics: aggregateDiagnostics(), baselines: [{ id: "flat", label: "Always flat", evaluation }], policyId: "policy-1",
    instruments: 1, episodes: 3, skippedInstruments: 0, createdAt: 100, updatedAt: 100,
  }
}

function runDiagnostics() {
  return { decisions: 1, actions: { flat: 0, long: 1, short: 0 }, turnover: 2, trades: 1, averageHoldingMinutes: 10, grossPnl: 2, costs: 1, netPnl: 1, longPnl: 1, shortPnl: 0, byTicker: [{ symbol: "F_TEST0826", trades: 1, grossPnl: 2, costs: 1, netPnl: 1 }] }
}

function aggregateDiagnostics() {
  return { runs: 1, meanDecisions: 1, meanActions: { flat: 0, long: 1, short: 0 }, meanTurnover: 2, meanTrades: 1, meanHoldingMinutes: 10, meanGrossPnl: 2, meanCosts: 1, meanNetPnl: 1, meanLongPnl: 1, meanShortPnl: 0, byTicker: [{ symbol: "F_TEST0826", meanTrades: 1, meanGrossPnl: 2, meanCosts: 1, meanNetPnl: 1 }] }
}

function policy() {
  return {
    id: "policy-1", name: "Policy", algorithm: "LINEAR_Q" as const, featureVersion: "viop-linear-q-v2" as const, featureNames: ["return_1" as const],
    configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0, seed: 1 },
    snapshot: { featureCount: 1, biases: { FLAT: 0, LONG: 0, SHORT: 0 }, weights: { FLAT: [0], LONG: [0], SHORT: [0] } },
    costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 }, partitions: { train: ["2026-08-07"], validation: ["2026-08-10"], test: ["2026-08-11"] },
    training: { epochs: 1, sessions: 1, instruments: 1, decisions: 1 },
    validation: { sessions: 1, instruments: 1, decisions: 1, trades: 1, wins: 1, losses: 0, profitableSessions: 1, netPnl: 1, averageSessionReturnPercent: 0.01, worstSessionDrawdown: 0 },
    test: { sessions: 1, instruments: 1, decisions: 1, trades: 1, wins: 1, losses: 0, profitableSessions: 1, netPnl: 1, averageSessionReturnPercent: 0.01, worstSessionDrawdown: 0 },
    createdAt: 100, updatedAt: 100,
  }
}
