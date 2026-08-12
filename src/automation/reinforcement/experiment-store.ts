import type { BacktestCosts } from "../backtest.ts"
import type { LinearQConfiguration } from "./linear-q-policy.ts"
import type { ReinforcementEvaluationSummary } from "./store.ts"

export const REINFORCEMENT_EXPERIMENT_VERSION = "viop-walk-forward-v5" as const

export type ReinforcementExperimentVerdict = "ACCEPTED" | "REJECTED"
export type ReinforcementHoldoutStatus = "EVALUATED" | "VALIDATION_REJECTED" | "AWAITING_UNSEEN_SESSIONS"

export interface ReinforcementExperimentManifest {
  version: typeof REINFORCEMENT_EXPERIMENT_VERSION | "viop-walk-forward-v1" | "viop-walk-forward-v2" | "viop-walk-forward-v3" | "viop-walk-forward-v4"
  featureVersion: string
  featureNames: string[]
  requestedStartDate: string
  cutoffDate: string
  unseenAfterDate?: string | null
  universe: Array<{ uid: string; symbol: string }>
  costs: BacktestCosts
  epochs: number
  seeds: number[]
  candidates: Array<{
    id: string
    configuration: Omit<LinearQConfiguration, "seed">
    trainingTurnoverPenaltyBps?: number
    trainingCostPenaltyMultiplier?: number
  }>
  protocol: {
    minimumTrainSessions: number
    validationSessions: number
    holdoutSessions: number
    maximumValidationWindows?: number
  }
}

export interface AggregateEvaluation {
  runs: number
  profitableRuns: number
  meanNetPnl: number
  medianNetPnl: number
  meanReturnPercent: number
  meanTrades: number
  meanWinRatePercent: number
  worstDrawdown: number
}

export interface ReinforcementRunDiagnostics {
  decisions: number
  actions: { flat: number; long: number; short: number }
  turnover: number
  trades: number
  averageHoldingMinutes: number
  grossPnl: number
  costs: number
  netPnl: number
  longPnl: number
  shortPnl: number
  byTicker: Array<{ symbol: string; trades: number; grossPnl: number; costs: number; netPnl: number }>
}

export interface AggregateReinforcementDiagnostics {
  runs: number
  meanDecisions: number
  meanActions: { flat: number; long: number; short: number }
  meanTurnover: number
  meanTrades: number
  meanHoldingMinutes: number
  meanGrossPnl: number
  meanCosts: number
  meanNetPnl: number
  meanLongPnl: number
  meanShortPnl: number
  byTicker: Array<{ symbol: string; meanTrades: number; meanGrossPnl: number; meanCosts: number; meanNetPnl: number }>
}

export interface ReinforcementExperimentArtifact {
  id: string
  manifest: ReinforcementExperimentManifest
  eligibleDates: string[]
  windows: Array<{ train: string[]; validation: string[] }>
  candidates: Array<{
    id: string
    validation: AggregateEvaluation
    diagnostics?: AggregateReinforcementDiagnostics
  }>
  selectedCandidate: string
  validation: AggregateEvaluation
  validationBaselines: Array<{ id: string; label: string; evaluation: AggregateEvaluation }>
  verdict: ReinforcementExperimentVerdict
  rejectionReasons: string[]
  holdoutDates: string[]
  holdoutStatus?: ReinforcementHoldoutStatus
  testRuns: Array<{ seed: number; evaluation: ReinforcementEvaluationSummary; diagnostics: ReinforcementRunDiagnostics }>
  test: AggregateEvaluation | null
  diagnostics: AggregateReinforcementDiagnostics | null
  baselines: Array<{ id: string; label: string; evaluation: ReinforcementEvaluationSummary }>
  policyId: string | null
  instruments: number
  episodes: number
  skippedInstruments: number
  createdAt: number
  updatedAt: number
}

export interface ReinforcementExperimentStore {
  put(artifact: ReinforcementExperimentArtifact): Promise<void>
  get(id: string): Promise<ReinforcementExperimentArtifact | null>
  latest(): Promise<ReinforcementExperimentArtifact | null>
  list(): Promise<ReinforcementExperimentArtifact[]>
  delete(id: string): Promise<boolean>
}

export class NullReinforcementExperimentStore implements ReinforcementExperimentStore {
  async put(): Promise<void> {}
  async get(): Promise<ReinforcementExperimentArtifact | null> { return null }
  async latest(): Promise<ReinforcementExperimentArtifact | null> { return null }
  async list(): Promise<ReinforcementExperimentArtifact[]> { return [] }
  async delete(): Promise<boolean> { return false }
}
