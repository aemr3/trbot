import { desc, eq } from "drizzle-orm"
import type {
  ReinforcementPolicyArtifact,
  ReinforcementPolicyStore,
} from "../automation/reinforcement/store.ts"
import type { AppDatabase } from "./client.ts"
import { reinforcementPolicies } from "./schema.ts"

export class DrizzleReinforcementPolicyStore implements ReinforcementPolicyStore {
  constructor(private readonly db: AppDatabase) {}

  async put(artifact: ReinforcementPolicyArtifact): Promise<void> {
    const values = encodeArtifact(artifact)
    await this.db.insert(reinforcementPolicies).values(values).onConflictDoUpdate({
      target: reinforcementPolicies.id,
      set: values,
    })
  }

  async get(id: string): Promise<ReinforcementPolicyArtifact | null> {
    const [row] = await this.db.select().from(reinforcementPolicies)
      .where(eq(reinforcementPolicies.id, id)).limit(1)
    return row ? decodeArtifact(row) : null
  }

  async latest(featureVersion?: string): Promise<ReinforcementPolicyArtifact | null> {
    const query = this.db.select().from(reinforcementPolicies)
    const [row] = featureVersion
      ? await query.where(eq(reinforcementPolicies.featureVersion, featureVersion))
        .orderBy(desc(reinforcementPolicies.createdAt)).limit(1)
      : await query.orderBy(desc(reinforcementPolicies.createdAt)).limit(1)
    return row ? decodeArtifact(row) : null
  }

  async list(featureVersion?: string): Promise<ReinforcementPolicyArtifact[]> {
    const query = this.db.select().from(reinforcementPolicies)
    const rows = featureVersion
      ? await query.where(eq(reinforcementPolicies.featureVersion, featureVersion))
        .orderBy(desc(reinforcementPolicies.createdAt))
      : await query.orderBy(desc(reinforcementPolicies.createdAt))
    return rows.map(decodeArtifact)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.select({ id: reinforcementPolicies.id }).from(reinforcementPolicies)
      .where(eq(reinforcementPolicies.id, id)).limit(1)
    if (rows.length === 0) return false
    await this.db.delete(reinforcementPolicies).where(eq(reinforcementPolicies.id, id))
    return true
  }
}

type PolicyRow = typeof reinforcementPolicies.$inferSelect
type PolicyInsert = typeof reinforcementPolicies.$inferInsert

function encodeArtifact(artifact: ReinforcementPolicyArtifact): PolicyInsert {
  return {
    id: artifact.id,
    name: artifact.name,
    algorithm: artifact.algorithm,
    featureVersion: artifact.featureVersion,
    featureNamesJson: JSON.stringify(artifact.featureNames),
    configurationJson: JSON.stringify(artifact.configuration),
    snapshotJson: JSON.stringify(artifact.snapshot),
    costsJson: JSON.stringify(artifact.costs),
    partitionsJson: JSON.stringify(artifact.partitions),
    trainingJson: JSON.stringify(artifact.training),
    validationJson: JSON.stringify(artifact.validation),
    testJson: JSON.stringify(artifact.test),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

function decodeArtifact(row: PolicyRow): ReinforcementPolicyArtifact {
  if (row.algorithm !== "LINEAR_Q") throw new Error(`Unsupported reinforcement algorithm ${row.algorithm}`)
  if (row.featureVersion !== "viop-linear-q-v2") {
    throw new Error(`Unsupported reinforcement feature version ${row.featureVersion}`)
  }
  const configuration = JSON.parse(row.configurationJson) as ReinforcementPolicyArtifact["configuration"]
  configuration.actionMargin ??= 0
  configuration.executionCostMarginMultiplier ??= 0
  return {
    id: row.id,
    name: row.name,
    algorithm: row.algorithm,
    featureVersion: row.featureVersion,
    featureNames: JSON.parse(row.featureNamesJson),
    configuration,
    snapshot: JSON.parse(row.snapshotJson),
    costs: JSON.parse(row.costsJson),
    partitions: JSON.parse(row.partitionsJson),
    training: JSON.parse(row.trainingJson),
    validation: JSON.parse(row.validationJson),
    test: JSON.parse(row.testJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
