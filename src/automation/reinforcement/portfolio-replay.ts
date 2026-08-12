import {
  DEFAULT_BACKTEST_COSTS,
  DEFAULT_BACKTEST_STARTING_BALANCE,
  buildPortfolioSnapshot,
  buildTradingContextFromSnapshot,
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
  type StrategyStateSnapshot,
  type TradeAction,
} from "../backtest.ts"
import { REINFORCEMENT_ACTIONS, type ReinforcementPolicy } from "./linear-q-policy.ts"
import {
  type ReinforcementReplayEpisode,
  type ReplayStep,
} from "./replay.ts"
import {
  prepareReplayDataset,
  type PreparedReplayEpisode,
  type PreparedReplayEvent,
  type PreparedReplaySession,
} from "./prepared-replay.ts"
import { extractReinforcementState } from "./state.ts"
import type { ReinforcementEvaluationSummary } from "./store.ts"

interface PortfolioRuntime {
  episode: PreparedReplayEpisode
  position: OpenPositionState | null
  records: BacktestDecisionRecord[]
  steps: ReplayStep[]
  closedPositions: ClosedPositionSnapshot[]
  pendingUpdate: PendingUpdate | null
  strategyState: StrategyStateSnapshot
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
  const prepared = prepareReplayDataset(episodes)
  if (prepared.sessions.length !== 1) {
    throw new Error("Portfolio reinforcement replay must contain exactly one session date")
  }
  return replayPreparedPortfolioSession(policy, prepared.sessions[0]!, options)
}

export function replayPreparedPortfolioSession(
  policy: ReinforcementPolicy,
  session: PreparedReplaySession,
  options: {
    training?: boolean
    startingBalance?: number
    costs?: BacktestCosts
    trainingTurnoverPenaltyBps?: number
    trainingCostPenaltyMultiplier?: number
  } = {},
): PortfolioReplayResult {
  if (session.episodes.length === 0) throw new Error("Portfolio reinforcement replay has no instruments")

  const training = options.training === true
  const trainingTurnoverPenaltyBps = options.trainingTurnoverPenaltyBps ?? 0
  if (!(Number.isFinite(trainingTurnoverPenaltyBps) && trainingTurnoverPenaltyBps >= 0)) {
    throw new Error("Training turnover penalty must be a finite non-negative number")
  }
  const trainingCostPenaltyMultiplier = options.trainingCostPenaltyMultiplier ?? 0
  if (!(Number.isFinite(trainingCostPenaltyMultiplier) && trainingCostPenaltyMultiplier >= 0)) {
    throw new Error("Training cost penalty multiplier must be a finite non-negative number")
  }
  const startingBalance = options.startingBalance ?? session.episodes[0]?.startingBalance ?? DEFAULT_BACKTEST_STARTING_BALANCE
  const costs = options.costs ?? session.episodes[0]?.costs ?? DEFAULT_BACKTEST_COSTS
  const runtimes = session.episodes.map((episode): PortfolioRuntime => ({
    episode,
    position: null,
    records: [],
    steps: [],
    closedPositions: [],
    pendingUpdate: null,
    strategyState: emptyStrategyState(startingBalance),
  }))
  let cumulativeNetPnl = 0
  let realizedPnl = 0
  let endingPortfolio = portfolioAt(session.schedule[0]!.timestamp, startingBalance, 0, 0, runtimes)

  for (const scheduled of session.schedule) {
    const timestamp = scheduled.timestamp
    const events = scheduled.events.map(({ episodeIndex, eventIndex }) => ({
      runtime: runtimes[episodeIndex]!,
      event: runtimes[episodeIndex]!.episode.events[eventIndex]!,
    }))
    const portfolio = portfolioAt(timestamp, startingBalance, cumulativeNetPnl, realizedPnl, runtimes)
    const pending = events.map((event): PendingEvent => {
      const context = contextFor(event.runtime, event.event, portfolio, startingBalance, costs)
      const features = extractReinforcementState(
        context,
        event.runtime.position,
      ).values
      const allowedActions = actionsAllowedByCollateral(context.collateral.canOpenFromFlat, event.runtime.position)
      return {
        runtime: event.runtime,
        sequence: event.event.sequence,
        decisionIndex: event.event.decisionIndex,
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
      const preparedEvent = runtime.episode.events[event.sequence]!
      const nextCandle = preparedEvent.nextCandle
      const terminal = event.sequence === runtime.episode.events.length - 1
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
      runtime.strategyState = advanceStrategyState(runtime.strategyState, decision, simulation.result)
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
      Math.max(...pending.map((event) => event.runtime.episode.events[event.sequence]!.nextCandle.timestamp)),
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
    sessionDate: session.sessionDate,
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
  return evaluatePreparedPortfolioSessions(policy, prepareReplayDataset(episodes).sessions)
}

export function evaluatePreparedPortfolioSessions(
  policy: ReinforcementPolicy,
  sessions: readonly PreparedReplaySession[],
): PortfolioReplayResult[] {
  return sessions.map((session) => replayPreparedPortfolioSession(policy, session))
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
  event: PreparedReplayEvent,
  portfolio: PortfolioStateSnapshot,
  startingBalance: number,
  costs: BacktestCosts,
): TradingContext {
  return buildTradingContextFromSnapshot(
    event.market,
    runtime.episode.identity,
    runtime.episode.rules,
    {
      startingBalance,
      portfolio,
      universe: runtime.episode.universe ?? null,
      strategyState: runtime.strategyState,
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

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function emptyStrategyState(startingBalance: number): StrategyStateSnapshot {
  return {
    startingBalance,
    runningBalance: startingBalance,
    cumulativeNetPnl: 0,
    priorPredictions: 0,
    priorNonFlatTargets: 0,
    priorPositiveIntervals: 0,
    priorNegativeIntervals: 0,
    recentDecisions: [],
  }
}

function advanceStrategyState(
  state: StrategyStateSnapshot,
  decision: TradingDecision,
  result: BacktestDecisionRecord["result"],
): StrategyStateSnapshot {
  const cumulativeNetPnl = state.cumulativeNetPnl + result.netPnl
  return {
    ...state,
    runningBalance: state.startingBalance + cumulativeNetPnl,
    cumulativeNetPnl,
    priorPredictions: state.priorPredictions + 1,
    priorNonFlatTargets: state.priorNonFlatTargets + (decision.action === "FLAT" ? 0 : 1),
    priorPositiveIntervals: state.priorPositiveIntervals + (result.netPnl > 0 ? 1 : 0),
    priorNegativeIntervals: state.priorNegativeIntervals + (result.netPnl < 0 ? 1 : 0),
    recentDecisions: [...state.recentDecisions.slice(-4), {
      action: decision.action,
      confidence: decision.confidence,
      netPnl: result.netPnl,
      decisionAt: result.decisionAt,
      transition: result.transition,
    }],
  }
}
