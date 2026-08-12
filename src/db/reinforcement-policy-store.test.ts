import { expect, test } from "bun:test"
import type { ReinforcementPolicyArtifact } from "../automation/reinforcement/store.ts"
import { openDatabase } from "./client.ts"
import { DrizzleReinforcementPolicyStore } from "./reinforcement-policy-store.ts"

test("persists and restores a reproducible reinforcement policy artifact", async () => {
  const connection = await openDatabase(":memory:")
  const store = new DrizzleReinforcementPolicyStore(connection.db)
  const artifact = policyArtifact()

  await store.put(artifact)

  expect(await store.get(artifact.id)).toEqual(artifact)
  expect(await store.latest("viop-linear-q-v2")).toEqual(artifact)
  expect(await store.list("viop-linear-q-v2")).toEqual([artifact])
  expect(await store.delete(artifact.id)).toBe(true)
  expect(await store.get(artifact.id)).toBeNull()
  connection.close()
})

function policyArtifact(): ReinforcementPolicyArtifact {
  return {
    id: "policy-1",
    name: "VIOP linear Q 2026-08-11",
    algorithm: "LINEAR_Q",
    featureVersion: "viop-linear-q-v2",
    featureNames: ["return_1", "return_3"],
    configuration: { learningRate: 0.02, discountFactor: 0.95, explorationRate: 0.1, actionMargin: 0, executionCostMarginMultiplier: 0, seed: 7 },
    snapshot: {
      featureCount: 2,
      biases: { FLAT: 0, LONG: 0.1, SHORT: -0.1 },
      weights: { FLAT: [0, 0], LONG: [0.2, 0.3], SHORT: [-0.2, -0.3] },
    },
    costs: { slippageBpsPerSide: 2, commissionBpsPerSide: 0 },
    partitions: {
      train: ["2026-08-03", "2026-08-04", "2026-08-05"],
      validation: ["2026-08-06"],
      test: ["2026-08-07"],
    },
    training: { epochs: 4, sessions: 3, instruments: 9, decisions: 180 },
    validation: evaluation(1),
    test: evaluation(2),
    createdAt: 100,
    updatedAt: 100,
  }
}

function evaluation(netPnl: number) {
  return {
    sessions: 1,
    instruments: 3,
    decisions: 60,
    trades: 4,
    wins: 3,
    losses: 1,
    profitableSessions: 1,
    netPnl,
    averageSessionReturnPercent: netPnl / 200,
    worstSessionDrawdown: 3,
  }
}
