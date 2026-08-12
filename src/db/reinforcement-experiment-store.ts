import { desc, eq } from "drizzle-orm"
import type {
  AggregateReinforcementDiagnostics,
  ReinforcementExperimentArtifact,
  ReinforcementExperimentStore,
  ReinforcementRunDiagnostics,
} from "../automation/reinforcement/experiment-store.ts"
import type { AppDatabase } from "./client.ts"
import { reinforcementExperiments, reinforcementPolicies } from "./schema.ts"

export class DrizzleReinforcementExperimentStore implements ReinforcementExperimentStore {
  constructor(private readonly db: AppDatabase) {}

  async put(artifact: ReinforcementExperimentArtifact): Promise<void> {
    await this.db.insert(reinforcementExperiments).values(encode(artifact)).onConflictDoUpdate({
      target: reinforcementExperiments.id,
      set: encode(artifact),
    })
  }

  async get(id: string): Promise<ReinforcementExperimentArtifact | null> {
    const [row] = await this.db.select().from(reinforcementExperiments)
      .where(eq(reinforcementExperiments.id, id)).limit(1)
    return row ? decode(row.artifactJson) : null
  }

  async latest(): Promise<ReinforcementExperimentArtifact | null> {
    const [row] = await this.db.select().from(reinforcementExperiments)
      .orderBy(desc(reinforcementExperiments.createdAt)).limit(1)
    return row ? decode(row.artifactJson) : null
  }

  async list(): Promise<ReinforcementExperimentArtifact[]> {
    const rows = await this.db.select().from(reinforcementExperiments)
      .orderBy(desc(reinforcementExperiments.createdAt))
    return rows.map((row) => decode(row.artifactJson))
  }

  async delete(id: string): Promise<boolean> {
    const [row] = await this.db.select({ policyId: reinforcementExperiments.policyId })
      .from(reinforcementExperiments).where(eq(reinforcementExperiments.id, id)).limit(1)
    if (!row) return false
    await this.db.transaction(async (tx) => {
      await tx.delete(reinforcementExperiments).where(eq(reinforcementExperiments.id, id))
      if (row.policyId) await tx.delete(reinforcementPolicies).where(eq(reinforcementPolicies.id, row.policyId))
    })
    return true
  }
}

type ExperimentInsert = typeof reinforcementExperiments.$inferInsert

function encode(artifact: ReinforcementExperimentArtifact): ExperimentInsert {
  return {
    id: artifact.id,
    featureVersion: artifact.manifest.featureVersion,
    cutoffDate: artifact.manifest.cutoffDate,
    policyId: artifact.policyId,
    artifactJson: JSON.stringify(artifact),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

function decode(value: string): ReinforcementExperimentArtifact {
  const artifact = JSON.parse(value) as ReinforcementExperimentArtifact
  if (!artifact.verdict) {
    const rejected = artifact.validation.meanNetPnl <= 0
      || artifact.validation.medianNetPnl <= 0
      || artifact.validation.profitableRuns <= artifact.validation.runs / 2
    artifact.verdict = rejected ? "REJECTED" : "ACCEPTED"
    artifact.rejectionReasons = rejected ? ["Legacy experiment did not pass the current validation gate"] : []
  }
  artifact.validationBaselines ??= []
  for (const candidate of artifact.manifest.candidates) {
    candidate.configuration.actionMargin ??= 0
    candidate.configuration.executionCostMarginMultiplier ??= 0
  }
  artifact.holdoutStatus ??= artifact.testRuns.length > 0 ? "EVALUATED" : "VALIDATION_REJECTED"
  artifact.testRuns = artifact.testRuns.map((run) => ({
    ...run,
    diagnostics: run.diagnostics ?? emptyRunDiagnostics(),
  }))
  if (artifact.holdoutStatus === "EVALUATED") artifact.diagnostics ??= emptyAggregateDiagnostics()
  return artifact
}

function emptyRunDiagnostics(): ReinforcementRunDiagnostics {
  return {
    decisions: 0,
    actions: { flat: 0, long: 0, short: 0 },
    turnover: 0,
    trades: 0,
    averageHoldingMinutes: 0,
    grossPnl: 0,
    costs: 0,
    netPnl: 0,
    longPnl: 0,
    shortPnl: 0,
    byTicker: [],
  }
}

function emptyAggregateDiagnostics(): AggregateReinforcementDiagnostics {
  return {
    runs: 0,
    meanDecisions: 0,
    meanActions: { flat: 0, long: 0, short: 0 },
    meanTurnover: 0,
    meanTrades: 0,
    meanHoldingMinutes: 0,
    meanGrossPnl: 0,
    meanCosts: 0,
    meanNetPnl: 0,
    meanLongPnl: 0,
    meanShortPnl: 0,
    byTicker: [],
  }
}
