import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type {
  ReinforcementBacktestResult,
  ReinforcementBacktestSource,
} from "../automation/reinforcement/backtest-runner.ts"
import type { ReinforcementExperimentArtifact, ReinforcementExperimentStore } from "../automation/reinforcement/experiment-store.ts"
import type { ReinforcementPolicyArtifact } from "../automation/reinforcement/store.ts"
import type { ViopInstrument } from "../market/instrument.ts"
import { ReinforcementBacktestScreen } from "./reinforcement-backtest.ts"

const instrument: ViopInstrument = {
  uid: "future-1",
  symbol: "F_THYAO0826",
  displayName: "THYAO",
  underlyingSymbol: "THYAO",
  lastPrice: 312,
  changePercent: 1,
  volume: 1_000,
  currency: "TRY",
}

test("runs an automatic walk-forward experiment and displays aggregate holdout results", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 130, height: 38, kittyKeyboard: true })
  let runs = 0
  const source: ReinforcementBacktestSource = {
    async run(_instruments, options) {
      runs++
      options.onProgress?.({
        phase: "VALIDATING",
        completed: 2,
        total: 4,
        currentSymbol: null,
        sessionDates: 5,
        instruments: 3,
        skippedInstruments: 1,
      })
      return result()
    },
  }
  const screen = new ReinforcementBacktestScreen(renderer, {
    source,
    instruments: [instrument],
    onClose() {},
  })
  renderer.root.add(screen.root)
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))

  const idle = await waitForFrame((frame) => frame.includes("Ready to run"))
  expect(idle).toContain("Linear Q")
  expect(idle).toContain("walk-forward")
  expect(idle).not.toContain("OpenAI")
  expect(idle).not.toContain("AI decisions")
  expect(idle).not.toContain("D dates")
  expect(idle).not.toContain("REINFORCEMENT EXPERIMENT")
  expect(idle.split("\n").at(-2)).toContain("Enter run experiment")
  mockInput.pressEnter()

  const completed = await waitForFrame((frame) => frame.includes("Experiment accepted") && frame.includes("Mean end balance"))
  expect(runs).toBe(1)
  expect(completed).toContain("viop-walk-forward-v2")
  expect(completed).toContain("Start balance")
  expect(completed).toContain("Worst drawdown")
  expect(completed).toContain("03, 04, 05, 06, 07 Aug 2026")

  screen.destroy()
  renderer.destroy()
})

test("shows validation rejection reasons and does not present a deployable policy", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 140, height: 36, kittyKeyboard: true })
  const rejected = experiment()
  rejected.verdict = "REJECTED"
  rejected.rejectionReasons = ["Validation mean P&L is not positive", "Validation does not beat Always flat"]
  rejected.policyId = null
  rejected.holdoutStatus = "VALIDATION_REJECTED"
  rejected.testRuns = []
  rejected.test = null
  rejected.diagnostics = null
  rejected.baselines = []
  const screen = new ReinforcementBacktestScreen(renderer, {
    source: { async run() { return { ...result(), artifact: null, experiment: rejected } } },
    instruments: [instrument],
    onClose() {},
  })
  renderer.root.add(screen.root)
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))

  await waitForFrame((frame) => frame.includes("Ready to run"))
  mockInput.pressEnter()
  const frame = await waitForFrame((value) => value.includes("Experiment rejected") && value.includes("REJECTION REASONS"))
  expect(frame).toContain("Not saved · validation rejected")
  expect(frame).toContain("Validation does not beat Always flat")
  expect(frame).toContain("Not run · validation rejected")

  screen.destroy()
  renderer.destroy()
})

test("lists and deletes saved experiments after confirmation", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 120, height: 34, kittyKeyboard: true })
  const saved = [experiment()]
  const deletion: { id: string | null } = { id: null }
  const experiments: Pick<ReinforcementExperimentStore, "list" | "delete"> = {
    async list() { return [...saved] },
    async delete(id) {
      deletion.id = id
      saved.splice(0)
      return true
    },
  }
  const screen = new ReinforcementBacktestScreen(renderer, {
    source: { async run() { return result() } },
    experiments,
    instruments: [instrument],
    onClose() {},
  })
  renderer.root.add(screen.root)
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  screen.mount()

  const stored = await waitForFrame((frame) => frame.includes("SAVED EXPERIMENTS") && frame.includes("07 Aug 2026"))
  expect(stored).toContain("X manage saved experiments")
  mockInput.pressKey("x")
  await waitForFrame((frame) => frame.includes("Enter delete"))
  mockInput.pressEnter()
  const confirmation = await waitForFrame((frame) => frame.includes("Enter confirm"))
  expect(confirmation).toContain("Delete this experiment")
  mockInput.pressEnter()

  const deleted = await waitForFrame((frame) => frame.includes("Deleted experiment and its policy."))
  expect(deletion.id).toBe("experiment-1")
  expect(deleted).toContain("No experiments saved yet")

  screen.destroy()
  renderer.destroy()
})

function result(): ReinforcementBacktestResult {
  return {
    artifact: policy(),
    experiment: experiment(),
    cached: false,
    skippedInputs: 1,
    startDate: "2026-08-03",
    endDate: "2026-08-07",
    sessionDates: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"],
    instruments: 3,
    episodes: 15,
    skippedInstruments: 1,
  }
}

function experiment(): ReinforcementExperimentArtifact {
  return {
    id: "experiment-1",
    manifest: {
      version: "viop-walk-forward-v2",
      featureVersion: "viop-linear-q-v2",
      featureNames: ["return_1"],
      requestedStartDate: "2026-06-01",
      cutoffDate: "2026-08-07",
      universe: [{ uid: instrument.uid, symbol: instrument.symbol }],
      costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 },
      epochs: 4,
      seeds: [11, 29, 47],
      candidates: [{ id: "balanced", configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0 } }],
      protocol: { minimumTrainSessions: 20, validationSessions: 5, holdoutSessions: 5 },
    },
    eligibleDates: ["2026-07-01", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"],
    windows: [{ train: ["2026-07-01"], validation: ["2026-08-03"] }],
    candidates: [{ id: "balanced", validation: aggregate(20) }],
    selectedCandidate: "balanced",
    validation: aggregate(20),
    validationBaselines: [{ id: "flat", label: "Always flat", evaluation: aggregate(0) }],
    verdict: "ACCEPTED",
    rejectionReasons: [],
    holdoutDates: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"],
    testRuns: [{ seed: 11, evaluation: evaluation(-5), diagnostics: runDiagnostics(-5) }, { seed: 29, evaluation: evaluation(2), diagnostics: runDiagnostics(2) }, { seed: 47, evaluation: evaluation(-1), diagnostics: runDiagnostics(-1) }],
    test: aggregate(-2),
    diagnostics: diagnostics(-2),
    baselines: [{ id: "flat", label: "Always flat", evaluation: evaluation(0) }],
    policyId: "policy-1",
    instruments: 3,
    episodes: 15,
    skippedInstruments: 1,
    createdAt: Date.parse("2026-08-11T12:00:00+03:00"),
    updatedAt: Date.parse("2026-08-11T12:00:00+03:00"),
  }
}

function aggregate(netPnl: number) {
  return { runs: 3, profitableRuns: netPnl > 0 ? 2 : 1, meanNetPnl: netPnl, medianNetPnl: netPnl, meanReturnPercent: netPnl / 200, meanTrades: 4, meanWinRatePercent: 50, worstDrawdown: 10 }
}

function runDiagnostics(netPnl: number) {
  return { decisions: 60, actions: { flat: 20, long: 20, short: 20 }, turnover: 8, trades: 4, averageHoldingMinutes: 20, grossPnl: netPnl + 2, costs: 2, netPnl, longPnl: netPnl / 2, shortPnl: netPnl / 2, byTicker: [{ symbol: instrument.symbol, trades: 4, grossPnl: netPnl + 2, costs: 2, netPnl }] }
}

function diagnostics(netPnl: number) {
  return { runs: 3, meanDecisions: 60, meanActions: { flat: 20, long: 20, short: 20 }, meanTurnover: 8, meanTrades: 4, meanHoldingMinutes: 20, meanGrossPnl: netPnl + 2, meanCosts: 2, meanNetPnl: netPnl, meanLongPnl: netPnl / 2, meanShortPnl: netPnl / 2, byTicker: [{ symbol: instrument.symbol, meanTrades: 4, meanGrossPnl: netPnl + 2, meanCosts: 2, meanNetPnl: netPnl }] }
}

function policy(): ReinforcementPolicyArtifact {
  return {
    id: "policy-1",
    name: "VIOP linear Q 2026-08-11",
    algorithm: "LINEAR_Q",
    featureVersion: "viop-linear-q-v2",
    featureNames: ["return_1"],
    configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0, seed: 1 },
    snapshot: {
      featureCount: 1,
      biases: { FLAT: 0, LONG: 0, SHORT: 0 },
      weights: { FLAT: [0], LONG: [0], SHORT: [0] },
    },
    costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 },
    partitions: {
      train: ["2026-08-03", "2026-08-04", "2026-08-05"],
      validation: ["2026-08-06"],
      test: ["2026-08-07"],
    },
    training: { epochs: 4, sessions: 3, instruments: 9, decisions: 180 },
    validation: evaluation(20),
    test: evaluation(-5),
    createdAt: Date.parse("2026-08-11T12:00:00+03:00"),
    updatedAt: Date.parse("2026-08-11T12:00:00+03:00"),
  }
}

function evaluation(netPnl: number) {
  return {
    sessions: 1,
    instruments: 3,
    decisions: 60,
    trades: 4,
    wins: 2,
    losses: 2,
    profitableSessions: netPnl > 0 ? 1 : 0,
    netPnl,
    averageSessionReturnPercent: netPnl / 200,
    worstSessionDrawdown: 10,
  }
}
