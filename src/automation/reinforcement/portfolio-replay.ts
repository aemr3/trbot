import {
  DEFAULT_BACKTEST_COSTS,
  DEFAULT_BACKTEST_STARTING_BALANCE,
  buildPortfolioSnapshot,
  buildTradingContext,
  calculateBacktestMetrics,
  enforceCollateralBudget,
  simulatePositionDecision,
  type InstrumentDecision,
  type TradingContext,
  type TradingDecision,
  type BacktestCosts,
  type BacktestDecisionRecord,
  type BacktestMetrics,
  type ClosedPositionSnapshot,
  type OpenPositionState,
  type PortfolioStateSnapshot,
  type TradeAction,
} from "../backtest.ts"
import { REINFORCEMENT_ACTIONS, type ReinforcementPolicy } from "./linear-q-policy.ts"
import {
  validateReplayEpisode,
  type ReinforcementReplayEpisode,
  type ReplayStep,
} from "./replay.ts"
import { extractReinforcementState } from "./state.ts"
import type { ReinforcementEvaluationSummary } from "./store.ts"

interface PortfolioRuntime {
  episode: ReinforcementReplayEpisode
  position: OpenPositionState | null
  records: BacktestDecisionRecord[]
  steps: ReplayStep[]
  closedPositions: ClosedPositionSnapshot[]
  pendingUpdate: PendingUpdate | null
}

interface PendingUpdate {
  features: number[]
  action: TradeAction
  reward: number
}

interface PendingEvent {
  runtime: PortfolioRuntime
  sequence: number
  decisionIndex: number
  context: TradingContext
  features: number[]
  allowedActions: readonly TradeAction[]
  explored: boolean
  requestedDecision: InstrumentDecision
}

export interface PortfolioReplayResult {
  sessionDate: string
  records: BacktestDecisionRecord[]
  metrics: BacktestMetrics
  endingPortfolio: PortfolioStateSnapshot
  tickers: Array<{
    instrumentUid: string
    symbol: string
    steps: ReplayStep[]
    records: BacktestDecisionRecord[]
    metrics: BacktestMetrics
  }>
}

export function replayPortfolioSession(
  policy: ReinforcementPolicy,
  episodes: readonly ReinforcementReplayEpisode[],
  options: {
    training?: boolean
    startingBalance?: number
    costs?: BacktestCosts
    trainingTurnoverPenaltyBps?: number
    trainingCostPenaltyMultiplier?: number
  } = {},
): PortfolioReplayResult {
  if (episodes.length === 0) throw new Error("Portfolio reinforcement replay has no instruments")
  for (const episode of episodes) validateReplayEpisode(episode)
  const sessionDate = episodes[0]!.sessionDate
  if (episodes.some((episode) => episode.sessionDate !== sessionDate)) {
    throw new Error("Portfolio reinforcement replay must contain exactly one session date")
  }
  const instrumentUids = new Set(episodes.map((episode) => episode.identity.instrumentUid))
  if (instrumentUids.size !== episodes.length) {
    throw new Error("Portfolio reinforcement replay contains a duplicate instrument")
  }

  const training = options.training === true
  const trainingTurnoverPenaltyBps = options.trainingTurnoverPenaltyBps ?? 0
  if (!(Number.isFinite(trainingTurnoverPenaltyBps) && trainingTurnoverPenaltyBps >= 0)) {
    throw new Error("Training turnover penalty must be a finite non-negative number")
  }
  const trainingCostPenaltyMultiplier = options.trainingCostPenaltyMultiplier ?? 0
  if (!(Number.isFinite(trainingCostPenaltyMultiplier) && trainingCostPenaltyMultiplier >= 0)) {
    throw new Error("Training cost penalty multiplier must be a finite non-negative number")
  }
  const startingBalance = options.startingBalance ?? episodes[0]?.startingBalance ?? DEFAULT_BACKTEST_STARTING_BALANCE
  const costs = options.costs ?? episodes[0]?.costs ?? DEFAULT_BACKTEST_COSTS
  const runtimes = episodes.map((episode): PortfolioRuntime => ({
    episode,
    position: null,
    records: [],
    steps: [],
    closedPositions: [],
    pendingUpdate: null,
  }))
  const timestamps = [...new Set(runtimes.flatMap(({ episode }) => episode.decisionIndexes.map(
    (index) => episode.candles[index]!.timestamp,
  )))].sort((left, right) => left - right)
  let cumulativeNetPnl = 0
  let realizedPnl = 0
  let endingPortfolio = portfolioAt(timestamps[0]!, startingBalance, 0, 0, runtimes)

  for (const timestamp of timestamps) {
    const events = runtimes.flatMap((runtime) => {
      const sequence = runtime.episode.decisionIndexes.findIndex(
        (index) => runtime.episode.candles[index]?.timestamp === timestamp,
      )
      return sequence < 0 ? [] : [{ runtime, sequence, decisionIndex: runtime.episode.decisionIndexes[sequence]! }]
    })
    const portfolio = portfolioAt(timestamp, startingBalance, cumulativeNetPnl, realizedPnl, runtimes)
    const pending = events.map((event): PendingEvent => {
      const context = contextFor(event.runtime, event.decisionIndex, portfolio, startingBalance, costs)
      const features = extractReinforcementState(
        context,
        event.runtime.position,
      ).values
      const allowedActions = actionsAllowedByCollateral(context.collateral.canOpenFromFlat, event.runtime.position)
      return {
        ...event,
        context,
        features,
        allowedActions,
        explored: false,
        requestedDecision: {
          instrumentUid: context.instrumentUid,
          action: "FLAT",
          confidence: 0,
          thesis: "Reinforcement policy target",
          riskFlags: [],
        },
      }
    })

    if (training) {
      for (const event of pending) {
        const prior = event.runtime.pendingUpdate
        if (!prior) continue
        policy.update(prior.features, prior.action, prior.reward, event.features, event.allowedActions)
        event.runtime.pendingUpdate = null
      }
    }
    for (const event of pending) {
      const preferredAction = event.runtime.position?.side ?? "FLAT"
      const selection = policy.select(event.features, {
        explore: training,
        allowedActions: event.allowedActions,
        preferredAction,
        minimumAdvantageByAction: economicActionMargins(
          event.context,
          preferredAction,
          policy.configuration?.executionCostMarginMultiplier ?? 0,
          startingBalance,
        ),
      })
      event.explored = selection.explored
      event.requestedDecision = {
        instrumentUid: event.context.instrumentUid,
        action: selection.action,
        confidence: actionConfidence(selection.action, selection.qValues),
        thesis: "Reinforcement policy target",
        riskFlags: [],
      }
    }
    const guarded = enforceCollateralBudget(portfolio, pending.map((event) => ({
      context: event.context,
      position: event.runtime.position,
      decision: event.requestedDecision,
    })))
    const guardedByInstrument = new Map(guarded.map((decision) => [decision.instrumentUid, decision]))

    for (const event of pending) {
      const { runtime } = event
      const guardedDecision = guardedByInstrument.get(event.context.instrumentUid)!
      const decision: TradingDecision = {
        action: guardedDecision.action,
        confidence: guardedDecision.confidence,
        thesis: guardedDecision.thesis,
        riskFlags: guardedDecision.riskFlags,
      }
      const nextCandle = runtime.episode.candles[event.decisionIndex + 1]!
      const terminal = event.sequence === runtime.episode.decisionIndexes.length - 1
      const simulation = simulatePositionDecision(
        event.context,
        decision,
        nextCandle,
        runtime.position,
        costs,
        terminal,
      )
      runtime.position = simulation.position
      cumulativeNetPnl += simulation.result.netPnl
      for (const trade of simulation.result.closedTrades) {
        realizedPnl += trade.netPnl
        runtime.closedPositions.push({ ...runtime.episode.identity, ...trade })
      }
      const record = { context: event.context, decision, result: simulation.result }
      runtime.records.push(record)
      const turnoverPenalty = training
        ? transitionTurnover(simulation.result.transition) * trainingTurnoverPenaltyBps / 10_000
        : 0
      const costPenalty = training
        ? Math.max(0, simulation.result.costs) / startingBalance * trainingCostPenaltyMultiplier
        : 0
      const reward = simulation.result.netPnl / startingBalance - turnoverPenalty - costPenalty
      runtime.steps.push({
        decisionIndex: event.decisionIndex,
        action: decision.action,
        reward,
        explored: event.explored,
        record,
      })
      if (training) {
        if (terminal) policy.update(event.features, decision.action, reward, null)
        else runtime.pendingUpdate = { features: event.features, action: decision.action, reward }
      }
    }
    endingPortfolio = portfolioAt(
      Math.max(...pending.map((event) => event.runtime.episode.candles[event.decisionIndex + 1]!.timestamp)),
      startingBalance,
      cumulativeNetPnl,
      realizedPnl,
      runtimes,
    )
  }

  const records = runtimes.flatMap((runtime) => runtime.records)
    .sort((left, right) => left.result.decisionAt - right.result.decisionAt
      || left.context.symbol.localeCompare(right.context.symbol))
  return {
    sessionDate,
    records,
    metrics: calculateBacktestMetrics(records, startingBalance),
    endingPortfolio,
    tickers: runtimes.map((runtime) => ({
      ...runtime.episode.identity,
      steps: runtime.steps,
      records: runtime.records,
      metrics: calculateBacktestMetrics(runtime.records, startingBalance),
    })),
  }
}

export function evaluatePortfolioSessions(
  policy: ReinforcementPolicy,
  episodes: readonly ReinforcementReplayEpisode[],
): PortfolioReplayResult[] {
  return groupBySessionDate(episodes).map((session) => replayPortfolioSession(policy, session))
}

export function summarizeEvaluation(results: readonly PortfolioReplayResult[]): ReinforcementEvaluationSummary {
  const metrics = results.map((result) => result.metrics)
  return {
    sessions: results.length,
    instruments: results.reduce((total, result) => total + result.tickers.length, 0),
    decisions: metrics.reduce((total, metric) => total + metric.predictions, 0),
    trades: metrics.reduce((total, metric) => total + metric.trades, 0),
    wins: metrics.reduce((total, metric) => total + metric.wins, 0),
    losses: metrics.reduce((total, metric) => total + metric.losses, 0),
    profitableSessions: metrics.filter((metric) => metric.netPnl > 0).length,
    netPnl: metrics.reduce((total, metric) => total + metric.netPnl, 0),
    averageSessionReturnPercent: average(metrics.map((metric) => metric.returnPercent)),
    worstSessionDrawdown: Math.max(0, ...metrics.map((metric) => metric.maxDrawdown)),
  }
}

function contextFor(
  runtime: PortfolioRuntime,
  decisionIndex: number,
  portfolio: PortfolioStateSnapshot,
  startingBalance: number,
  costs: BacktestCosts,
): TradingContext {
  return buildTradingContext(
    runtime.episode.candles,
    decisionIndex,
    runtime.episode.identity,
    runtime.episode.rules,
    {
      startingBalance,
      portfolio,
      universe: runtime.episode.universe ?? null,
      priorDecisions: runtime.records.map(({ decision, result }) => ({
        action: decision.action,
        confidence: decision.confidence,
        netPnl: result.netPnl,
        decisionAt: result.decisionAt,
        transition: result.transition,
      })),
    },
    costs,
  )
}

function portfolioAt(
  asOf: number,
  startingBalance: number,
  cumulativeNetPnl: number,
  realizedPnl: number,
  runtimes: PortfolioRuntime[],
): PortfolioStateSnapshot {
  return buildPortfolioSnapshot(
    asOf,
    startingBalance,
    cumulativeNetPnl,
    realizedPnl,
    runtimes.flatMap((runtime) => runtime.position ? [runtime.position] : []),
    runtimes.flatMap((runtime) => runtime.closedPositions),
  )
}

function actionsAllowedByCollateral(
  canOpenFromFlat: boolean,
  position: OpenPositionState | null,
): readonly TradeAction[] {
  return position || canOpenFromFlat ? REINFORCEMENT_ACTIONS : ["FLAT"]
}

function actionConfidence(action: TradeAction, qValues: Record<TradeAction, number>): number {
  const alternatives = REINFORCEMENT_ACTIONS.filter((candidate) => candidate !== action)
  const advantage = qValues[action] - Math.max(...alternatives.map((candidate) => qValues[candidate]))
  return 1 / (1 + Math.exp(-advantage))
}

function transitionTurnover(transition: "FLAT" | "OPEN" | "HOLD" | "CLOSE" | "REVERSE"): number {
  if (transition === "OPEN" || transition === "CLOSE") return 1
  if (transition === "REVERSE") return 2
  return 0
}

function economicActionMargins(
  context: TradingContext,
  preferredAction: TradeAction,
  multiplier: number,
  startingBalance: number,
): Partial<Record<TradeAction, number>> {
  if (multiplier <= 0) return {}
  const price = context.candles.at(-1)?.close ?? 0
  const perSideRate = (Math.max(0, context.costs.slippageBpsPerSide)
    + Math.max(0, context.costs.commissionBpsPerSide)) / 10_000
  const perSideCostFraction = price * context.rules.contractMultiplier * perSideRate / startingBalance
  return Object.fromEntries(REINFORCEMENT_ACTIONS.map((action) => {
    if (action === preferredAction) return [action, 0]
    const executionSides = preferredAction === "FLAT" ? 2 : action === "FLAT" ? 1 : 2
    return [action, perSideCostFraction * executionSides * multiplier]
  }))
}

function groupBySessionDate(
  episodes: readonly ReinforcementReplayEpisode[],
): ReinforcementReplayEpisode[][] {
  const groups = new Map<string, ReinforcementReplayEpisode[]>()
  for (const episode of episodes) {
    const group = groups.get(episode.sessionDate) ?? []
    group.push(episode)
    groups.set(episode.sessionDate, group)
  }
  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, group]) => group.sort((left, right) => left.identity.symbol.localeCompare(right.identity.symbol)))
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}
