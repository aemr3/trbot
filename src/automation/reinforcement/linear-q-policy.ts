import type { TradeAction } from "../backtest.ts"

export const REINFORCEMENT_ACTIONS = ["FLAT", "LONG", "SHORT"] as const satisfies readonly TradeAction[]

export interface LinearQConfiguration {
  learningRate: number
  discountFactor: number
  explorationRate: number
  actionMargin: number
  executionCostMarginMultiplier: number
  seed: number
}

export interface ActionSelectionOptions {
  explore?: boolean
  allowedActions?: readonly TradeAction[]
  preferredAction?: TradeAction
  minimumAdvantageByAction?: Partial<Record<TradeAction, number>>
}

export interface LinearQPolicySnapshot {
  featureCount: number
  weights: Record<TradeAction, number[]>
  biases: Record<TradeAction, number>
}

export interface ActionSelection {
  action: TradeAction
  qValues: Record<TradeAction, number>
  explored: boolean
}

export interface ReinforcementPolicy {
  readonly configuration?: LinearQConfiguration
  select(
    features: readonly number[],
    options?: ActionSelectionOptions,
  ): ActionSelection
  update(
    features: readonly number[],
    action: TradeAction,
    reward: number,
    nextFeatures: readonly number[] | null,
    nextAllowedActions?: readonly TradeAction[],
  ): number
}

const DEFAULT_CONFIGURATION: LinearQConfiguration = {
  learningRate: 0.02,
  discountFactor: 0.95,
  explorationRate: 0.1,
  actionMargin: 0,
  executionCostMarginMultiplier: 0,
  seed: 1,
}

export class LinearQPolicy {
  readonly configuration: LinearQConfiguration
  private readonly weights: Record<TradeAction, number[]>
  private readonly biases: Record<TradeAction, number>
  private randomState: number

  constructor(
    readonly featureCount: number,
    configuration: Partial<LinearQConfiguration> = {},
    snapshot?: LinearQPolicySnapshot,
  ) {
    if (!Number.isInteger(featureCount) || featureCount < 1) {
      throw new Error("Linear Q policy needs at least one feature")
    }
    this.configuration = validateConfiguration({ ...DEFAULT_CONFIGURATION, ...configuration })
    this.randomState = normalizeSeed(this.configuration.seed)
    this.weights = emptyActionRecord(() => Array.from({ length: featureCount }, () => 0))
    this.biases = emptyActionRecord(() => 0)
    if (snapshot) this.restore(snapshot)
  }

  select(
    features: readonly number[],
    options: ActionSelectionOptions = {},
  ): ActionSelection {
    this.validateFeatures(features)
    const allowed = validateAllowedActions(options.allowedActions)
    const qValues = this.qValues(features)
    const shouldExplore = options.explore === true
      && allowed.length > 1
      && this.nextRandom() < this.configuration.explorationRate
    if (shouldExplore) {
      return {
        action: allowed[Math.floor(this.nextRandom() * allowed.length)]!,
        qValues,
        explored: true,
      }
    }
    const bestAction = maximumAction(qValues, allowed)
    const preferredAction = options.preferredAction
    const requestedAdvantage = options.minimumAdvantageByAction?.[bestAction] ?? 0
    if (!(Number.isFinite(requestedAdvantage) && requestedAdvantage >= 0)) {
      throw new Error("Minimum action advantage must be a finite non-negative number")
    }
    const requiredAdvantage = Math.max(
      this.configuration.actionMargin,
      requestedAdvantage,
    )
    const action = preferredAction !== undefined
      && allowed.includes(preferredAction)
      && qValues[bestAction] - qValues[preferredAction] < requiredAdvantage
      ? preferredAction
      : bestAction
    return { action, qValues, explored: false }
  }

  update(
    features: readonly number[],
    action: TradeAction,
    reward: number,
    nextFeatures: readonly number[] | null,
    nextAllowedActions: readonly TradeAction[] = REINFORCEMENT_ACTIONS,
  ): number {
    this.validateFeatures(features)
    if (!Number.isFinite(reward)) throw new Error("Reinforcement reward must be finite")
    if (nextFeatures) this.validateFeatures(nextFeatures)
    const current = this.score(action, features)
    const future = nextFeatures
      ? Math.max(...validateAllowedActions(nextAllowedActions).map((candidate) => this.score(candidate, nextFeatures)))
      : 0
    const error = reward + this.configuration.discountFactor * future - current
    const adjustment = this.configuration.learningRate * error
    this.biases[action] += adjustment
    for (let index = 0; index < this.featureCount; index++) {
      this.weights[action][index]! += adjustment * features[index]!
    }
    return error
  }

  qValues(features: readonly number[]): Record<TradeAction, number> {
    this.validateFeatures(features)
    return emptyActionRecord((action) => this.score(action, features))
  }

  snapshot(): LinearQPolicySnapshot {
    return {
      featureCount: this.featureCount,
      weights: emptyActionRecord((action) => [...this.weights[action]]),
      biases: { ...this.biases },
    }
  }

  private score(action: TradeAction, features: readonly number[]): number {
    let score = this.biases[action]
    for (let index = 0; index < this.featureCount; index++) {
      score += this.weights[action][index]! * features[index]!
    }
    return score
  }

  private restore(snapshot: LinearQPolicySnapshot): void {
    if (snapshot.featureCount !== this.featureCount) {
      throw new Error("Linear Q snapshot feature count does not match the policy")
    }
    for (const action of REINFORCEMENT_ACTIONS) {
      const weights = snapshot.weights[action]
      if (weights.length !== this.featureCount || weights.some((value) => !Number.isFinite(value))) {
        throw new Error(`Linear Q snapshot has invalid ${action} weights`)
      }
      const bias = snapshot.biases[action]
      if (!Number.isFinite(bias)) throw new Error(`Linear Q snapshot has an invalid ${action} bias`)
      this.weights[action] = [...weights]
      this.biases[action] = bias
    }
  }

  private validateFeatures(features: readonly number[]): void {
    if (features.length !== this.featureCount || features.some((value) => !Number.isFinite(value))) {
      throw new Error(`Expected ${this.featureCount} finite reinforcement features`)
    }
  }

  private nextRandom(): number {
    let state = this.randomState
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    this.randomState = state >>> 0
    return this.randomState / 0x1_0000_0000
  }
}

function maximumAction(
  qValues: Record<TradeAction, number>,
  allowedActions: readonly TradeAction[],
): TradeAction {
  let best = allowedActions[0]!
  for (const action of allowedActions.slice(1)) {
    if (qValues[action] > qValues[best]) best = action
  }
  return best
}

function emptyActionRecord<T>(factory: (action: TradeAction) => T): Record<TradeAction, T> {
  return {
    FLAT: factory("FLAT"),
    LONG: factory("LONG"),
    SHORT: factory("SHORT"),
  }
}

function validateAllowedActions(actions: readonly TradeAction[] | undefined): readonly TradeAction[] {
  const allowed = actions ?? REINFORCEMENT_ACTIONS
  if (allowed.length === 0 || allowed.some((action) => !REINFORCEMENT_ACTIONS.includes(action))) {
    throw new Error("Linear Q policy received invalid allowed actions")
  }
  return [...new Set(allowed)]
}

function validateConfiguration(configuration: LinearQConfiguration): LinearQConfiguration {
  if (!(configuration.learningRate > 0 && configuration.learningRate <= 1)) {
    throw new Error("Learning rate must be in (0, 1]")
  }
  if (!(configuration.discountFactor >= 0 && configuration.discountFactor <= 1)) {
    throw new Error("Discount factor must be in [0, 1]")
  }
  if (!(configuration.explorationRate >= 0 && configuration.explorationRate <= 1)) {
    throw new Error("Exploration rate must be in [0, 1]")
  }
  if (!(Number.isFinite(configuration.actionMargin) && configuration.actionMargin >= 0)) {
    throw new Error("Action margin must be a finite non-negative number")
  }
  if (!(Number.isFinite(configuration.executionCostMarginMultiplier) && configuration.executionCostMarginMultiplier >= 0)) {
    throw new Error("Execution-cost margin multiplier must be a finite non-negative number")
  }
  return configuration
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) throw new Error("Linear Q seed must be finite")
  return (Math.trunc(seed) >>> 0) || 1
}
