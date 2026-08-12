import type { BacktestCosts } from "../backtest.ts"
import type { LinearQConfiguration, LinearQPolicySnapshot } from "./linear-q-policy.ts"
import type { ReinforcementFeatureName } from "./state.ts"

export const REINFORCEMENT_FEATURE_VERSION = "viop-linear-q-v2" as const

export interface ReinforcementDatePartitions {
  train: string[]
  validation: string[]
  test: string[]
}

export interface ReinforcementTrainingSummary {
  epochs: number
  sessions: number
  instruments: number
  decisions: number
}

export interface ReinforcementEvaluationSummary {
  sessions: number
  instruments: number
  decisions: number
  trades: number
  wins: number
  losses: number
  profitableSessions: number
  netPnl: number
  averageSessionReturnPercent: number
  worstSessionDrawdown: number
}

export interface ReinforcementPolicyArtifact {
  id: string
  name: string
  algorithm: "LINEAR_Q"
  featureVersion: typeof REINFORCEMENT_FEATURE_VERSION
  featureNames: ReinforcementFeatureName[]
  configuration: LinearQConfiguration
  snapshot: LinearQPolicySnapshot
  costs: BacktestCosts
  partitions: ReinforcementDatePartitions
  training: ReinforcementTrainingSummary
  validation: ReinforcementEvaluationSummary
  test: ReinforcementEvaluationSummary
  createdAt: number
  updatedAt: number
}

export interface ReinforcementPolicyStore {
  put(artifact: ReinforcementPolicyArtifact): Promise<void>
  get(id: string): Promise<ReinforcementPolicyArtifact | null>
  latest(featureVersion?: string): Promise<ReinforcementPolicyArtifact | null>
  list(featureVersion?: string): Promise<ReinforcementPolicyArtifact[]>
  delete(id: string): Promise<boolean>
}

export class NullReinforcementPolicyStore implements ReinforcementPolicyStore {
  async put(): Promise<void> {}
  async get(): Promise<ReinforcementPolicyArtifact | null> { return null }
  async latest(): Promise<ReinforcementPolicyArtifact | null> { return null }
  async list(): Promise<ReinforcementPolicyArtifact[]> { return [] }
  async delete(): Promise<boolean> { return false }
}
