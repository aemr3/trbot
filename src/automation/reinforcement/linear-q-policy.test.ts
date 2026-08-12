import { expect, test } from "bun:test"
import { LinearQPolicy } from "./linear-q-policy.ts"

test("learns the rewarded action while keeping safe FLAT tie-breaking", () => {
  const policy = new LinearQPolicy(2, {
    learningRate: 0.1,
    discountFactor: 0,
    explorationRate: 0.35,
    seed: 42,
  })
  const features = [1, -0.5]

  expect(policy.select(features).action).toBe("FLAT")
  for (let index = 0; index < 500; index++) {
    const selection = policy.select(features, { explore: true })
    const reward = selection.action === "LONG" ? 1 : selection.action === "SHORT" ? -1 : 0
    policy.update(features, selection.action, reward, null)
  }

  expect(policy.select(features).action).toBe("LONG")
  expect(policy.qValues(features).LONG).toBeGreaterThan(policy.qValues(features).FLAT)
})

test("evaluation and snapshot restoration do not mutate learned parameters", () => {
  const policy = new LinearQPolicy(1, { explorationRate: 1, seed: 7 })
  policy.update([1], "SHORT", 0.5, null)
  const before = policy.snapshot()
  const restored = new LinearQPolicy(1, {}, before)

  for (let index = 0; index < 20; index++) restored.select([1])

  expect(restored.snapshot()).toEqual(before)
  expect(restored.select([1]).action).toBe("SHORT")
})

test("retains the current position until another action clears the configured margin", () => {
  const snapshot = {
    featureCount: 1,
    biases: { FLAT: 0, LONG: 0.001, SHORT: -1 },
    weights: { FLAT: [0], LONG: [0], SHORT: [0] },
  }
  const sticky = new LinearQPolicy(1, { actionMargin: 0.002 }, snapshot)
  const responsive = new LinearQPolicy(1, { actionMargin: 0.0005 }, snapshot)

  expect(sticky.select([1], { preferredAction: "FLAT" }).action).toBe("FLAT")
  expect(responsive.select([1], { preferredAction: "FLAT" }).action).toBe("LONG")
})
