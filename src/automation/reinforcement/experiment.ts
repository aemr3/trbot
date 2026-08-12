import {
  DEFAULT_BACKTEST_COSTS,
  DEFAULT_BACKTEST_STARTING_BALANCE,
  type BacktestCosts,
  type TradeAction,
} from "../backtest.ts"
import {
  REINFORCEMENT_EXPERIMENT_VERSION,
  type AggregateEvaluation,
  type AggregateReinforcementDiagnostics,
  type ReinforcementExperimentArtifact,
  type ReinforcementExperimentManifest,
  type ReinforcementRunDiagnostics,
} from "./experiment-store.ts"
import {
  LinearQPolicy,
  type ActionSelection,
  type LinearQConfiguration,
  type ReinforcementPolicy,
} from "./linear-q-policy.ts"
import {
  evaluatePortfolioSessions,
  replayPortfolioSession,
  summarizeEvaluation,
  type PortfolioReplayResult,
} from "./portfolio-replay.ts"
import type { ReinforcementReplayEpisode } from "./replay.ts"
import {
  REINFORCEMENT_FEATURE_VERSION,
  type ReinforcementEvaluationSummary,
  type ReinforcementPolicyArtifact,
} from "./store.ts"
import { REINFORCEMENT_FEATURE_NAMES } from "./state.ts"

export interface WalkForwardProtocol {
  minimumTrainSessions: number
  validationSessions: number
  holdoutSessions: number
  maximumValidationWindows?: number
}

export interface ExperimentCandidate {
  id: string
  configuration: Omit<LinearQConfiguration, "seed">
  trainingTurnoverPenaltyBps?: number
  trainingCostPenaltyMultiplier?: number
}

export const DEFAULT_WALK_FORWARD_PROTOCOL: WalkForwardProtocol = {
  minimumTrainSessions: 20,
  validationSessions: 5,
  holdoutSessions: 5,
  maximumValidationWindows: 3,
}

export const DEFAULT_EXPERIMENT_SEEDS = [11, 29, 47]
export const DEFAULT_EXPERIMENT_CANDIDATES: ExperimentCandidate[] = [
  {
    id: "low-cost-gate",
    configuration: {
      learningRate: 0.02,
      discountFactor: 0.95,
      explorationRate: 0.1,
      actionMargin: 0,
      executionCostMarginMultiplier: 1,
    },
    trainingCostPenaltyMultiplier: 0.5,
  },
  {
    id: "medium-cost-gate",
    configuration: {
      learningRate: 0.02,
      discountFactor: 0.95,
      explorationRate: 0.1,
      actionMargin: 0,
      executionCostMarginMultiplier: 2,
    },
    trainingCostPenaltyMultiplier: 1,
  },
  {
    id: "high-cost-gate",
    configuration: {
      learningRate: 0.02,
      discountFactor: 0.95,
      explorationRate: 0.1,
      actionMargin: 0,
      executionCostMarginMultiplier: 4,
    },
    trainingCostPenaltyMultiplier: 2,
  },
]

const CANDIDATE_PNL_SIMILARITY = DEFAULT_BACKTEST_STARTING_BALANCE * 0.005

export interface ExperimentRunOptions {
  episodes: ReinforcementReplayEpisode[]
  skippedInstruments: number
  manifest: ReinforcementExperimentManifest
  policyId: string
  now: number
  signal?: AbortSignal
  onProgress?: (progress: { phase: "VALIDATING" | "TESTING" | "PERSISTING"; completed: number; total: number }) => void
}

export function buildWalkForwardWindows(
  dates: readonly string[],
  protocol: WalkForwardProtocol,
  unseenAfterDate: string | null = null,
): {
  developmentDates: string[]
  holdoutDates: string[]
  holdoutReady: boolean
  windows: Array<{ train: string[]; validation: string[] }>
} {
  validateProtocol(protocol)
  const ordered = [...new Set(dates)].sort()
  const unseenDates = unseenAfterDate === null
    ? ordered.slice(-protocol.holdoutSessions)
    : ordered.filter((date) => date > unseenAfterDate)
  const holdoutReady = unseenDates.length >= protocol.holdoutSessions
  const holdoutDates = holdoutReady ? unseenDates.slice(-protocol.holdoutSessions) : unseenDates
  const developmentEnd = holdoutDates[0]
  const developmentDates = developmentEnd
    ? ordered.filter((date) => date < developmentEnd)
    : ordered.filter((date) => unseenAfterDate === null || date <= unseenAfterDate)
  const requiredDevelopment = protocol.minimumTrainSessions + protocol.validationSessions
  if (developmentDates.length < requiredDevelopment) {
    throw new Error(`Walk-forward experiment needs at least ${requiredDevelopment} development sessions; ${developmentDates.length} available`)
  }
  const windows: Array<{ train: string[]; validation: string[] }> = []
  for (
    let validationStart = protocol.minimumTrainSessions;
    validationStart + protocol.validationSessions <= developmentDates.length;
    validationStart += protocol.validationSessions
  ) {
    windows.push({
      train: developmentDates.slice(0, validationStart),
      validation: developmentDates.slice(validationStart, validationStart + protocol.validationSessions),
    })
  }
  const finalValidationStart = developmentDates.length - protocol.validationSessions
  if (finalValidationStart >= protocol.minimumTrainSessions
    && windows.at(-1)?.validation.at(-1) !== developmentDates.at(-1)) {
    windows.push({
      train: developmentDates.slice(0, finalValidationStart),
      validation: developmentDates.slice(finalValidationStart),
    })
  }
  if (windows.length === 0) throw new Error("Walk-forward experiment has no validation window")
  const maximum = protocol.maximumValidationWindows ?? windows.length
  const selectedWindows = windows.length <= maximum ? windows : evenlySpaced(windows, maximum)
  return { developmentDates, holdoutDates, holdoutReady, windows: selectedWindows }
}

export function createExperimentManifest(options: {
  requestedStartDate: string
  cutoffDate: string
  unseenAfterDate?: string | null
  universe: Array<{ uid: string; symbol: string }>
  costs?: BacktestCosts
  epochs?: number
  seeds?: number[]
  candidates?: ExperimentCandidate[]
  protocol?: WalkForwardProtocol
}): ReinforcementExperimentManifest {
  const candidates = options.candidates ?? DEFAULT_EXPERIMENT_CANDIDATES
  return {
    version: REINFORCEMENT_EXPERIMENT_VERSION,
    featureVersion: REINFORCEMENT_FEATURE_VERSION,
    featureNames: [...REINFORCEMENT_FEATURE_NAMES],
    requestedStartDate: options.requestedStartDate,
    cutoffDate: options.cutoffDate,
    unseenAfterDate: options.unseenAfterDate ?? null,
    universe: [...options.universe].sort((left, right) => left.uid.localeCompare(right.uid)),
    costs: options.costs ?? DEFAULT_BACKTEST_COSTS,
    epochs: options.epochs ?? 4,
    seeds: [...(options.seeds ?? DEFAULT_EXPERIMENT_SEEDS)],
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      configuration: { ...candidate.configuration },
      trainingTurnoverPenaltyBps: candidate.trainingTurnoverPenaltyBps ?? 0,
      trainingCostPenaltyMultiplier: candidate.trainingCostPenaltyMultiplier ?? 0,
    })),
    protocol: { ...(options.protocol ?? DEFAULT_WALK_FORWARD_PROTOCOL) },
  }
}

export function experimentId(manifest: ReinforcementExperimentManifest): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(stableJson(manifest))
  return hasher.digest("hex")
}

export async function runWalkForwardExperiment(options: ExperimentRunOptions): Promise<{
  experiment: ReinforcementExperimentArtifact
  policy: ReinforcementPolicyArtifact | null
}> {
  const { manifest } = options
  const dates = uniqueDates(options.episodes)
  const split = buildWalkForwardWindows(dates, manifest.protocol, manifest.unseenAfterDate ?? null)
  const validationTotal = manifest.candidates.length * manifest.seeds.length * split.windows.length
  let validationCompleted = 0
  const candidates = [] as ReinforcementExperimentArtifact["candidates"]
  options.onProgress?.({ phase: "VALIDATING", completed: 0, total: validationTotal })
  for (const candidate of manifest.candidates) {
    const evaluations: ReinforcementEvaluationSummary[] = []
    const diagnostics: ReinforcementRunDiagnostics[] = []
    for (const window of split.windows) {
      for (const seed of manifest.seeds) {
        throwIfAborted(options.signal)
        const policy = await trainPolicy(
          filterDates(options.episodes, window.train),
          candidate.configuration,
          candidate.trainingTurnoverPenaltyBps ?? 0,
          candidate.trainingCostPenaltyMultiplier ?? 0,
          seed,
          manifest.epochs,
          options.signal,
        )
        const results = evaluatePortfolioSessions(policy, filterDates(options.episodes, window.validation))
        evaluations.push(summarizeEvaluation(results))
        diagnostics.push(summarizeDiagnostics(results))
        validationCompleted++
        options.onProgress?.({ phase: "VALIDATING", completed: validationCompleted, total: validationTotal })
        await Bun.sleep(0)
      }
    }
    candidates.push({
      id: candidate.id,
      validation: aggregateEvaluations(evaluations),
      diagnostics: aggregateDiagnostics(diagnostics),
    })
  }
  candidates.sort(compareCandidates)
  const selectedResult = selectCandidate(candidates)
  const selected = manifest.candidates.find((candidate) => candidate.id === selectedResult.id)!
  const validationBaselines = baselinePolicies().map(({ id, label, policy }) => ({
    id,
    label,
    evaluation: aggregateEvaluations(split.windows.map((window) => summarizeEvaluation(
      evaluatePortfolioSessions(policy, filterDates(options.episodes, window.validation)),
    ))),
  }))
  const rejectionReasons = assessValidation(selectedResult.validation, validationBaselines)
  const verdict = rejectionReasons.length === 0 ? "ACCEPTED" : "REJECTED"
  const holdoutStatus = verdict === "REJECTED"
    ? "VALIDATION_REJECTED"
    : split.holdoutReady ? "EVALUATED" : "AWAITING_UNSEEN_SESSIONS"
  const evaluateHoldout = holdoutStatus === "EVALUATED"
  const development = filterDates(options.episodes, split.developmentDates)
  const holdout = filterDates(options.episodes, split.holdoutDates)
  const testRuns: ReinforcementExperimentArtifact["testRuns"] = []
  let savedPolicy: LinearQPolicy | null = null
  if (evaluateHoldout) {
    options.onProgress?.({ phase: "TESTING", completed: 0, total: manifest.seeds.length + 5 })
    for (let index = 0; index < manifest.seeds.length; index++) {
      throwIfAborted(options.signal)
      const seed = manifest.seeds[index]!
      const policy = await trainPolicy(
        development,
        selected.configuration,
        selected.trainingTurnoverPenaltyBps ?? 0,
        selected.trainingCostPenaltyMultiplier ?? 0,
        seed,
        manifest.epochs,
        options.signal,
      )
      if (index === 0) savedPolicy = policy
      const results = evaluatePortfolioSessions(policy, holdout)
      testRuns.push({ seed, evaluation: summarizeEvaluation(results), diagnostics: summarizeDiagnostics(results) })
      options.onProgress?.({ phase: "TESTING", completed: index + 1, total: manifest.seeds.length + 5 })
      await Bun.sleep(0)
    }
  }
  const baselines = evaluateHoldout ? baselinePolicies().map(({ id, label, policy }, index) => {
    const evaluation = summarizeEvaluation(evaluatePortfolioSessions(policy, holdout))
    options.onProgress?.({ phase: "TESTING", completed: manifest.seeds.length + index + 1, total: manifest.seeds.length + 5 })
    return { id, label, evaluation }
  }) : []
  const createdAt = options.now
  const policy: ReinforcementPolicyArtifact | null = evaluateHoldout ? {
    id: options.policyId,
    name: `VIOP walk-forward ${manifest.cutoffDate}`,
    algorithm: "LINEAR_Q",
    featureVersion: REINFORCEMENT_FEATURE_VERSION,
    featureNames: [...REINFORCEMENT_FEATURE_NAMES],
    configuration: { ...selected.configuration, seed: manifest.seeds[0]! },
    snapshot: savedPolicy!.snapshot(),
    costs: manifest.costs,
    partitions: {
      train: split.developmentDates,
      validation: [...new Set(split.windows.flatMap((window) => window.validation))],
      test: split.holdoutDates,
    },
    training: {
      epochs: manifest.epochs,
      sessions: split.developmentDates.length,
      instruments: development.length,
      decisions: development.reduce((total, episode) => total + episode.decisionIndexes.length, 0) * manifest.epochs,
    },
    validation: evaluationFromAggregate(selectedResult.validation),
    test: testRuns[0]!.evaluation,
    createdAt,
    updatedAt: createdAt,
  } : null
  const experiment: ReinforcementExperimentArtifact = {
    id: experimentId(manifest),
    manifest,
    eligibleDates: dates,
    windows: split.windows,
    candidates,
    selectedCandidate: selected.id,
    validation: selectedResult.validation,
    validationBaselines,
    verdict,
    rejectionReasons,
    holdoutDates: split.holdoutDates,
    holdoutStatus,
    testRuns,
    test: evaluateHoldout ? aggregateEvaluations(testRuns.map((run) => run.evaluation)) : null,
    diagnostics: evaluateHoldout ? aggregateDiagnostics(testRuns.map((run) => run.diagnostics)) : null,
    baselines,
    policyId: policy?.id ?? null,
    instruments: new Set(options.episodes.map((episode) => episode.identity.instrumentUid)).size,
    episodes: options.episodes.length,
    skippedInstruments: options.skippedInstruments,
    createdAt,
    updatedAt: createdAt,
  }
  return { experiment, policy }
}

export function aggregateEvaluations(evaluations: readonly ReinforcementEvaluationSummary[]): AggregateEvaluation {
  const pnls = evaluations.map((item) => item.netPnl).sort((a, b) => a - b)
  const middle = Math.floor(pnls.length / 2)
  const median = pnls.length % 2 === 0 ? ((pnls[middle - 1] ?? 0) + (pnls[middle] ?? 0)) / 2 : (pnls[middle] ?? 0)
  return {
    runs: evaluations.length,
    profitableRuns: evaluations.filter((item) => item.netPnl > 0).length,
    meanNetPnl: average(evaluations.map((item) => item.netPnl)),
    medianNetPnl: median,
    meanReturnPercent: average(evaluations.map((item) => item.averageSessionReturnPercent)),
    meanTrades: average(evaluations.map((item) => item.trades)),
    meanWinRatePercent: average(evaluations.map((item) => item.trades > 0 ? item.wins / item.trades * 100 : 0)),
    worstDrawdown: Math.max(0, ...evaluations.map((item) => item.worstSessionDrawdown)),
  }
}

export function summarizeDiagnostics(results: readonly PortfolioReplayResult[]): ReinforcementRunDiagnostics {
  const records = results.flatMap((result) => result.records)
  const closed = records.flatMap((record) => record.result.closedTrades.map((trade) => ({
    symbol: record.context.symbol,
    trade,
  })))
  const tickerSymbols = [...new Set(records.map((record) => record.context.symbol))].sort()
  return {
    decisions: records.length,
    actions: {
      flat: records.filter((record) => record.decision.action === "FLAT").length,
      long: records.filter((record) => record.decision.action === "LONG").length,
      short: records.filter((record) => record.decision.action === "SHORT").length,
    },
    turnover: records.reduce((total, record) => total + transitionTurnover(record.result.transition), 0),
    trades: closed.length,
    averageHoldingMinutes: average(closed.map(({ trade }) => trade.holdingMinutes)),
    grossPnl: records.reduce((total, record) => total + record.result.grossPnl, 0),
    costs: records.reduce((total, record) => total + record.result.costs, 0),
    netPnl: records.reduce((total, record) => total + record.result.netPnl, 0),
    longPnl: closed.filter(({ trade }) => trade.side === "LONG").reduce((total, { trade }) => total + trade.netPnl, 0),
    shortPnl: closed.filter(({ trade }) => trade.side === "SHORT").reduce((total, { trade }) => total + trade.netPnl, 0),
    byTicker: tickerSymbols.map((symbol) => {
      const tickerRecords = records.filter((record) => record.context.symbol === symbol)
      const tickerTrades = closed.filter((item) => item.symbol === symbol)
      return {
        symbol,
        trades: tickerTrades.length,
        grossPnl: tickerRecords.reduce((total, record) => total + record.result.grossPnl, 0),
        costs: tickerRecords.reduce((total, record) => total + record.result.costs, 0),
        netPnl: tickerRecords.reduce((total, record) => total + record.result.netPnl, 0),
      }
    }),
  }
}

export function aggregateDiagnostics(runs: readonly ReinforcementRunDiagnostics[]): AggregateReinforcementDiagnostics {
  const symbols = [...new Set(runs.flatMap((run) => run.byTicker.map((ticker) => ticker.symbol)))].sort()
  return {
    runs: runs.length,
    meanDecisions: average(runs.map((run) => run.decisions)),
    meanActions: {
      flat: average(runs.map((run) => run.actions.flat)),
      long: average(runs.map((run) => run.actions.long)),
      short: average(runs.map((run) => run.actions.short)),
    },
    meanTurnover: average(runs.map((run) => run.turnover)),
    meanTrades: average(runs.map((run) => run.trades)),
    meanHoldingMinutes: average(runs.map((run) => run.averageHoldingMinutes)),
    meanGrossPnl: average(runs.map((run) => run.grossPnl)),
    meanCosts: average(runs.map((run) => run.costs)),
    meanNetPnl: average(runs.map((run) => run.netPnl)),
    meanLongPnl: average(runs.map((run) => run.longPnl)),
    meanShortPnl: average(runs.map((run) => run.shortPnl)),
    byTicker: symbols.map((symbol) => {
      const tickers = runs.map((run) => run.byTicker.find((ticker) => ticker.symbol === symbol))
        .filter((ticker): ticker is ReinforcementRunDiagnostics["byTicker"][number] => ticker !== undefined)
      return {
        symbol,
        meanTrades: average(tickers.map((ticker) => ticker.trades)),
        meanGrossPnl: average(tickers.map((ticker) => ticker.grossPnl)),
        meanCosts: average(tickers.map((ticker) => ticker.costs)),
        meanNetPnl: average(tickers.map((ticker) => ticker.netPnl)),
      }
    }).sort((left, right) => left.meanNetPnl - right.meanNetPnl),
  }
}

async function trainPolicy(
  episodes: ReinforcementReplayEpisode[],
  configuration: Omit<LinearQConfiguration, "seed">,
  trainingTurnoverPenaltyBps: number,
  trainingCostPenaltyMultiplier: number,
  seed: number,
  epochs: number,
  signal?: AbortSignal,
): Promise<LinearQPolicy> {
  const policy = new LinearQPolicy(REINFORCEMENT_FEATURE_NAMES.length, { ...configuration, seed })
  const sessions = groupBySession(episodes)
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const session of sessions) {
      throwIfAborted(signal)
      replayPortfolioSession(policy, session, {
        training: true,
        trainingTurnoverPenaltyBps,
        trainingCostPenaltyMultiplier,
      })
      await Bun.sleep(0)
    }
  }
  return policy
}

function baselinePolicies(): Array<{ id: string; label: string; policy: ReinforcementPolicy }> {
  return [
    { id: "flat", label: "Always flat", policy: new StaticPolicy(() => "FLAT") },
    { id: "long", label: "Always long", policy: new StaticPolicy(() => "LONG") },
    { id: "short", label: "Always short", policy: new StaticPolicy(() => "SHORT") },
    { id: "momentum", label: "3-bar momentum", policy: new StaticPolicy((features) => thresholdAction(features[1]!)) },
    { id: "mean-reversion", label: "SMA mean reversion", policy: new StaticPolicy((features) => thresholdAction(-features[4]!)) },
  ]
}

class StaticPolicy implements ReinforcementPolicy {
  constructor(private readonly decide: (features: readonly number[]) => TradeAction) {}

  select(features: readonly number[], options: { allowedActions?: readonly TradeAction[] } = {}): ActionSelection {
    const allowed = options.allowedActions ?? ["FLAT", "LONG", "SHORT"]
    const desired = this.decide(features)
    const action = allowed.includes(desired) ? desired : "FLAT"
    return { action, explored: false, qValues: { FLAT: action === "FLAT" ? 1 : 0, LONG: action === "LONG" ? 1 : 0, SHORT: action === "SHORT" ? 1 : 0 } }
  }

  update(): number { return 0 }
}

function thresholdAction(value: number): TradeAction {
  if (value > 0.05) return "LONG"
  if (value < -0.05) return "SHORT"
  return "FLAT"
}

function filterDates(episodes: ReinforcementReplayEpisode[], dates: readonly string[]): ReinforcementReplayEpisode[] {
  const included = new Set(dates)
  return episodes.filter((episode) => included.has(episode.sessionDate))
}

function uniqueDates(episodes: readonly ReinforcementReplayEpisode[]): string[] {
  return [...new Set(episodes.map((episode) => episode.sessionDate))].sort()
}

function groupBySession(episodes: readonly ReinforcementReplayEpisode[]): ReinforcementReplayEpisode[][] {
  const groups = new Map<string, ReinforcementReplayEpisode[]>()
  for (const episode of episodes) groups.set(episode.sessionDate, [...(groups.get(episode.sessionDate) ?? []), episode])
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group)
}

function evenlySpaced<T>(values: T[], count: number): T[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("maximumValidationWindows must be a positive integer")
  if (count === 1) return [values.at(-1)!]
  const indexes = Array.from({ length: count }, (_, index) => Math.round(index * (values.length - 1) / (count - 1)))
  return indexes.map((index) => values[index]!)
}

function compareCandidates(left: ReinforcementExperimentArtifact["candidates"][number], right: ReinforcementExperimentArtifact["candidates"][number]): number {
  return right.validation.meanNetPnl - left.validation.meanNetPnl
    || right.validation.medianNetPnl - left.validation.medianNetPnl
    || left.validation.worstDrawdown - right.validation.worstDrawdown
    || left.id.localeCompare(right.id)
}

export function selectCandidate(
  candidates: ReinforcementExperimentArtifact["candidates"],
): ReinforcementExperimentArtifact["candidates"][number] {
  if (candidates.length === 0) throw new Error("Reinforcement experiment has no candidates")
  const bestMeanPnl = Math.max(...candidates.map((candidate) => candidate.validation.meanNetPnl))
  return candidates
    .filter((candidate) => bestMeanPnl - candidate.validation.meanNetPnl <= CANDIDATE_PNL_SIMILARITY)
    .sort((left, right) => (left.diagnostics?.meanTurnover ?? Number.POSITIVE_INFINITY)
      - (right.diagnostics?.meanTurnover ?? Number.POSITIVE_INFINITY)
      || left.validation.worstDrawdown - right.validation.worstDrawdown
      || right.validation.meanNetPnl - left.validation.meanNetPnl
      || right.validation.medianNetPnl - left.validation.medianNetPnl
      || left.id.localeCompare(right.id))[0]!
}

export function assessValidation(
  validation: AggregateEvaluation,
  baselines: ReinforcementExperimentArtifact["validationBaselines"],
): string[] {
  const reasons: string[] = []
  const bestBaseline = baselines.reduce((best, baseline) => baseline.evaluation.meanNetPnl > best.evaluation.meanNetPnl ? baseline : best)
  if (validation.meanNetPnl <= 0) reasons.push("Validation mean P&L is not positive")
  if (validation.medianNetPnl <= 0) reasons.push("Validation median P&L is not positive")
  if (validation.profitableRuns <= validation.runs / 2) reasons.push("A majority of validation runs are not profitable")
  if (validation.meanNetPnl <= bestBaseline.evaluation.meanNetPnl) {
    reasons.push(`Validation does not beat ${bestBaseline.label}`)
  }
  return reasons
}

function transitionTurnover(transition: "FLAT" | "OPEN" | "HOLD" | "CLOSE" | "REVERSE"): number {
  if (transition === "OPEN" || transition === "CLOSE") return 1
  if (transition === "REVERSE") return 2
  return 0
}

function evaluationFromAggregate(value: AggregateEvaluation): ReinforcementEvaluationSummary {
  return {
    sessions: 0,
    instruments: 0,
    decisions: 0,
    trades: Math.round(value.meanTrades),
    wins: Math.round(value.meanTrades * value.meanWinRatePercent / 100),
    losses: Math.round(value.meanTrades * (100 - value.meanWinRatePercent) / 100),
    profitableSessions: value.profitableRuns,
    netPnl: value.meanNetPnl,
    averageSessionReturnPercent: value.meanReturnPercent,
    worstSessionDrawdown: value.worstDrawdown,
  }
}

function validateProtocol(protocol: WalkForwardProtocol): void {
  for (const [label, value] of Object.entries(protocol)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Reinforcement experiment cancelled", "AbortError")
}
