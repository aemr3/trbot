import { expect, test } from "bun:test"
import {
  aggregateEvaluations,
  assessValidation,
  buildWalkForwardWindows,
  createExperimentManifest,
  experimentId,
  selectCandidate,
} from "./experiment.ts"

test("builds expanding validation windows while preserving the newest holdout", () => {
  const dates = Array.from({ length: 40 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`)
  const result = buildWalkForwardWindows(dates, {
    minimumTrainSessions: 20,
    validationSessions: 5,
    holdoutSessions: 5,
  })

  expect(result.holdoutDates).toEqual(dates.slice(-5))
  expect(result.windows).toHaveLength(3)
  expect(result.windows.map((window) => [window.train.length, window.validation.length])).toEqual([[20, 5], [25, 5], [30, 5]])
  expect(result.windows.flatMap((window) => window.train)).not.toContain(dates.at(-1))
})

test("reserves only sessions newer than the last exposed holdout", () => {
  const dates = Array.from({ length: 40 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`)
  const protocol = { minimumTrainSessions: 20, validationSessions: 5, holdoutSessions: 5 }
  const ready = buildWalkForwardWindows(dates, protocol, dates[34])
  const waiting = buildWalkForwardWindows(dates, protocol, dates[37])
  const none = buildWalkForwardWindows(dates, protocol, dates.at(-1)!)

  expect(ready).toMatchObject({ holdoutReady: true, holdoutDates: dates.slice(-5) })
  expect(waiting).toMatchObject({ holdoutReady: false, holdoutDates: dates.slice(-2) })
  expect(none).toMatchObject({ holdoutReady: false, holdoutDates: [] })
  expect(none.windows.at(-1)?.validation.at(-1)).toBe(dates.at(-1))
})

test("makes experiment identity stable across universe ordering", () => {
  const shared = { requestedStartDate: "2026-04-01", cutoffDate: "2026-08-11" }
  const left = createExperimentManifest({ ...shared, universe: [{ uid: "b", symbol: "B" }, { uid: "a", symbol: "A" }] })
  const right = createExperimentManifest({ ...shared, universe: [{ uid: "a", symbol: "A" }, { uid: "b", symbol: "B" }] })

  expect(experimentId(left)).toBe(experimentId(right))
})

test("aggregates seed results without hiding the worst drawdown", () => {
  const result = aggregateEvaluations([evaluation(100, 20), evaluation(-50, 80), evaluation(25, 30)])
  expect(result).toMatchObject({ runs: 3, profitableRuns: 2, meanNetPnl: 25, medianNetPnl: 25, worstDrawdown: 80 })
})

test("rejects a candidate from validation alone when it loses to flat", () => {
  const candidate = aggregateEvaluations([evaluation(-10, 20), evaluation(5, 10), evaluation(-2, 15)])
  const flat = aggregateEvaluations([evaluation(0, 0), evaluation(0, 0), evaluation(0, 0)])

  expect(assessValidation(candidate, [{ id: "flat", label: "Always flat", evaluation: flat }])).toEqual([
    "Validation mean P&L is not positive",
    "Validation median P&L is not positive",
    "A majority of validation runs are not profitable",
    "Validation does not beat Always flat",
  ])
})

test("selects lower-turnover validation candidate when P&L is materially similar", () => {
  const candidate = selectCandidate([
    { id: "high-return", validation: aggregateEvaluations([evaluation(100, 80)]), diagnostics: diagnostics(100) },
    { id: "low-turnover", validation: aggregateEvaluations([evaluation(60, 40)]), diagnostics: diagnostics(10) },
    { id: "too-far", validation: aggregateEvaluations([evaluation(-10, 5)]), diagnostics: diagnostics(0) },
  ])

  expect(candidate.id).toBe("low-turnover")
})

function evaluation(netPnl: number, drawdown: number) {
  return {
    sessions: 5,
    instruments: 10,
    decisions: 50,
    trades: 10,
    wins: netPnl > 0 ? 6 : 4,
    losses: netPnl > 0 ? 4 : 6,
    profitableSessions: netPnl > 0 ? 3 : 2,
    netPnl,
    averageSessionReturnPercent: netPnl / 200,
    worstSessionDrawdown: drawdown,
  }
}

function diagnostics(turnover: number) {
  return {
    runs: 1,
    meanDecisions: 10,
    meanActions: { flat: 8, long: 1, short: 1 },
    meanTurnover: turnover,
    meanTrades: turnover / 2,
    meanHoldingMinutes: 20,
    meanGrossPnl: 0,
    meanCosts: 0,
    meanNetPnl: 0,
    meanLongPnl: 0,
    meanShortPnl: 0,
    byTicker: [],
  }
}
