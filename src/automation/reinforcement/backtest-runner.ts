import type { Candle, CandleSeries } from "../../market/candle.ts"
import type { BacktestCandleSource } from "../../market/candle-history.ts"
import type { ViopContractDetails, ViopInstrument, ViopInstrumentSource } from "../../market/instrument.ts"
import type { ViopOrderPreparation, ViopOrderSource } from "../../trading/order.ts"
import {
  BACKTEST_MIN_CONTEXT_BARS,
  DEFAULT_BACKTEST_COSTS,
  DEFAULT_BACKTEST_STARTING_BALANCE,
  completedCandles,
  type BacktestCosts,
  type MarketRuleSnapshot,
} from "../backtest.ts"
import { createViopRuleSnapshot } from "../market-rules.ts"
import type { ReinforcementDataset } from "./dataset.ts"
import {
  createExperimentManifest,
  DEFAULT_EXPERIMENT_CANDIDATES,
  DEFAULT_EXPERIMENT_SEEDS,
  DEFAULT_WALK_FORWARD_PROTOCOL,
  experimentId,
  type ExperimentCandidate,
  type ExperimentRunOptions,
  type ReinforcementExperimentResult,
  type WalkForwardProtocol,
} from "./experiment.ts"
import { runWalkForwardExperimentInWorker } from "./experiment-worker-client.ts"
import {
  NullReinforcementExperimentStore,
  type ReinforcementExperimentArtifact,
  type ReinforcementExperimentStore,
} from "./experiment-store.ts"
import type { ReinforcementReplayEpisode } from "./replay.ts"
import {
  NullReinforcementPolicyStore,
  type ReinforcementPolicyArtifact,
  type ReinforcementPolicyStore,
} from "./store.ts"

const TEN_MINUTES_MS = 10 * 60_000
const LOAD_CONCURRENCY = 4
const FIRST_DECISION_TIME = "10:20"

export type ReinforcementBacktestPhase =
  | "LOADING_HISTORY"
  | "PREPARING_DATASET"
  | "VALIDATING"
  | "TESTING"
  | "PERSISTING"

export interface ReinforcementBacktestProgress {
  phase: ReinforcementBacktestPhase
  completed: number
  total: number
  currentSymbol: string | null
  sessionDates: number
  instruments: number
  skippedInstruments: number
}

export interface ReinforcementBacktestResult {
  artifact: ReinforcementPolicyArtifact | null
  experiment: ReinforcementExperimentArtifact
  cached: boolean
  skippedInputs: number
  startDate: string
  endDate: string
  sessionDates: string[]
  instruments: number
  episodes: number
  skippedInstruments: number
}

export interface ReinforcementBacktestSource {
  run(
    instruments: ViopInstrument[],
    options: {
      signal?: AbortSignal
      onProgress?: (progress: ReinforcementBacktestProgress) => void
    },
  ): Promise<ReinforcementBacktestResult>
}

interface ReinforcementBacktestRunnerOptions {
  candles: BacktestCandleSource
  instruments: ViopInstrumentSource
  policies?: ReinforcementPolicyStore
  experiments?: ReinforcementExperimentStore
  orderPreparation?: Pick<ViopOrderSource, "prepareOrder">
  costs?: BacktestCosts
  lookbackDays?: number
  epochs?: number
  seeds?: number[]
  candidates?: ExperimentCandidate[]
  protocol?: WalkForwardProtocol
  now?: () => number
  createId?: () => string
  runExperiment?: (options: ExperimentRunOptions) => Promise<ReinforcementExperimentResult>
}

interface LoadedInstrument {
  instrument: ViopInstrument
  candles: Candle[]
  rules: MarketRuleSnapshot
}

export class HistoricalReinforcementBacktestRunner implements ReinforcementBacktestSource {
  private readonly costs: BacktestCosts
  private readonly now: () => number
  private readonly policies: ReinforcementPolicyStore
  private readonly experiments: ReinforcementExperimentStore
  private readonly runExperiment: (options: ExperimentRunOptions) => Promise<ReinforcementExperimentResult>

  constructor(private readonly options: ReinforcementBacktestRunnerOptions) {
    this.costs = options.costs ?? DEFAULT_BACKTEST_COSTS
    this.now = options.now ?? Date.now
    this.policies = options.policies ?? new NullReinforcementPolicyStore()
    this.experiments = options.experiments ?? new NullReinforcementExperimentStore()
    this.runExperiment = options.runExperiment ?? runWalkForwardExperimentInWorker
  }

  async run(
    instruments: ViopInstrument[],
    options: {
      signal?: AbortSignal
      onProgress?: (progress: ReinforcementBacktestProgress) => void
    },
  ): Promise<ReinforcementBacktestResult> {
    if (instruments.length === 0) throw new Error("No VIOP contracts are available for reinforcement training")
    const now = this.now()
    const endDate = latestCompletedSessionDate(now)
    const startDate = calendarDaysBefore(endDate, this.options.lookbackDays ?? 120)
    const unseenAfterDate = latestExposedHoldoutDate(await this.experiments.list())
    const manifest = createExperimentManifest({
      requestedStartDate: startDate,
      cutoffDate: endDate,
      unseenAfterDate,
      universe: instruments.map(({ uid, symbol }) => ({ uid, symbol })),
      costs: this.costs,
      epochs: this.options.epochs ?? 4,
      seeds: this.options.seeds ?? DEFAULT_EXPERIMENT_SEEDS,
      candidates: this.options.candidates ?? DEFAULT_EXPERIMENT_CANDIDATES,
      protocol: this.options.protocol ?? DEFAULT_WALK_FORWARD_PROTOCOL,
    })
    const cachedExperiment = await this.experiments.get(experimentId(manifest))
    if (cachedExperiment) {
      const policy = cachedExperiment.policyId ? await this.policies.get(cachedExperiment.policyId) : null
      if (!cachedExperiment.policyId || policy) return resultFromExperiment(cachedExperiment, policy, true)
    }
    let loadedCount = 0
    let skippedInstruments = 0
    const activeSymbols = new Set<string>()
    const progress = (phase: ReinforcementBacktestPhase, completed: number, total: number, dataset?: ReinforcementDataset) => {
      const dates = dataset ? uniqueDates(dataset.episodes) : []
      options.onProgress?.({
        phase,
        completed,
        total,
        currentSymbol: activeSymbols.size > 0 ? [...activeSymbols].join(", ") : null,
        sessionDates: dates.length,
        instruments: dataset ? uniqueInstruments(dataset.episodes).length : loadedCount,
        skippedInstruments,
      })
    }
    progress("LOADING_HISTORY", 0, instruments.length)

    const loaded = await mapWithConcurrency(instruments, LOAD_CONCURRENCY, async (instrument) => {
      throwIfAborted(options.signal)
      activeSymbols.add(instrument.symbol)
      progress("LOADING_HISTORY", loadedCount, instruments.length)
      try {
        const [series, details, preparation] = await Promise.all([
          this.loadRange(instrument, startDate, endDate, now, options.signal),
          this.loadDetails(instrument.uid, options.signal),
          this.loadPreparation(instrument.uid, options.signal),
        ])
        const candles = normalizeSeries(series, now)
        if (candles.length === 0) {
          skippedInstruments++
          return null
        }
        let rules: MarketRuleSnapshot
        try {
          rules = createViopRuleSnapshot(details, preparation, now)
        } catch {
          skippedInstruments++
          return null
        }
        return { instrument, candles, rules }
      } catch (error) {
        if (isAbortError(error)) throw error
        skippedInstruments++
        return null
      } finally {
        activeSymbols.delete(instrument.symbol)
        loadedCount++
        progress("LOADING_HISTORY", loadedCount, instruments.length)
      }
    })
    throwIfAborted(options.signal)
    const valid = loaded.filter((item): item is LoadedInstrument => item !== null)
    progress("PREPARING_DATASET", 0, valid.length)
    const episodes: ReinforcementReplayEpisode[] = []
    for (let index = 0; index < valid.length; index++) {
      throwIfAborted(options.signal)
      const item = valid[index]!
      activeSymbols.add(item.instrument.symbol)
      episodes.push(...episodesForInstrument(item, startDate, endDate, this.costs))
      activeSymbols.delete(item.instrument.symbol)
      progress("PREPARING_DATASET", index + 1, valid.length, { episodes, skippedInputs: skippedInstruments })
      await Bun.sleep(0)
    }
    const dataset: ReinforcementDataset = { episodes, skippedInputs: skippedInstruments }
    const sessionDates = uniqueDates(episodes)
    if (episodes.length === 0) throw new Error("No contracts have enough point-in-time history in the selected date range")

    const trained = await this.runExperiment({
      episodes: dataset.episodes,
      skippedInstruments,
      manifest,
      policyId: this.options.createId?.() ?? crypto.randomUUID(),
      now,
      signal: options.signal,
      onProgress: (training) => options.onProgress?.({
        phase: training.phase,
        completed: training.completed,
        total: training.total,
        currentSymbol: null,
        sessionDates: sessionDates.length,
        instruments: uniqueInstruments(episodes).length,
        skippedInstruments,
      }),
    })
    const persistenceSteps = trained.policy ? 2 : 1
    options.onProgress?.({ phase: "PERSISTING", completed: 0, total: persistenceSteps, currentSymbol: null,
      sessionDates: sessionDates.length, instruments: uniqueInstruments(episodes).length, skippedInstruments })
    if (trained.policy) {
      await this.policies.put(trained.policy)
      options.onProgress?.({ phase: "PERSISTING", completed: 1, total: persistenceSteps, currentSymbol: null,
        sessionDates: sessionDates.length, instruments: uniqueInstruments(episodes).length, skippedInstruments })
    }
    await this.experiments.put(trained.experiment)
    options.onProgress?.({ phase: "PERSISTING", completed: persistenceSteps, total: persistenceSteps, currentSymbol: null,
      sessionDates: sessionDates.length, instruments: uniqueInstruments(episodes).length, skippedInstruments })
    return resultFromExperiment(trained.experiment, trained.policy, false)
  }

  private loadRange(
    instrument: ViopInstrument,
    startDate: string,
    endDate: string,
    now: number,
    signal: AbortSignal | undefined,
  ): Promise<CandleSeries> {
    if (this.options.candles.loadRange) {
      return this.options.candles.loadRange(instrument, { startDate, endDate, now, signal })
    }
    return this.options.candles.loadCandles(instrument, { sessionDate: endDate, now, signal })
  }

  private async loadDetails(instrumentUid: string, signal: AbortSignal | undefined): Promise<ViopContractDetails | null> {
    try {
      return await this.options.instruments.loadContractDetails?.(instrumentUid, { signal }) ?? null
    } catch (error) {
      if (isAbortError(error)) throw error
      return null
    }
  }

  private async loadPreparation(
    instrumentUid: string,
    signal: AbortSignal | undefined,
  ): Promise<ViopOrderPreparation | null> {
    try {
      return await this.options.orderPreparation?.prepareOrder({ instrumentUid, side: "BUY", signal }) ?? null
    } catch (error) {
      if (isAbortError(error)) throw error
      return null
    }
  }
}

export function latestExposedHoldoutDate(experiments: readonly ReinforcementExperimentArtifact[]): string | null {
  const exposedDates = experiments.flatMap((experiment) => {
    const evaluated = experiment.holdoutStatus === "EVALUATED"
      || (experiment.holdoutStatus === undefined && experiment.testRuns.length > 0)
    return evaluated ? experiment.holdoutDates : []
  })
  return exposedDates.sort().at(-1) ?? null
}

function episodesForInstrument(
  loaded: LoadedInstrument,
  startDate: string,
  endDate: string,
  costs: BacktestCosts,
): ReinforcementReplayEpisode[] {
  const dates = uniqueDatesFromCandles(loaded.candles).filter((date) => date >= startDate && date <= endDate)
  return dates.flatMap((sessionDate) => {
    const firstDecision = sessionTime(sessionDate, FIRST_DECISION_TIME)
    const decisionIndexes = loaded.candles.flatMap((candle, index) => {
      const next = loaded.candles[index + 1]
      if (index < BACKTEST_MIN_CONTEXT_BARS - 1 || !next) return []
      if (candle.timestamp < firstDecision) return []
      if (sessionDateAt(candle.timestamp) !== sessionDate || sessionDateAt(next.timestamp) !== sessionDate) return []
      return [index]
    })
    if (decisionIndexes.length === 0) return []
    return [{
      sessionDate,
      candles: loaded.candles,
      decisionIndexes,
      identity: { instrumentUid: loaded.instrument.uid, symbol: loaded.instrument.symbol },
      rules: loaded.rules,
      startingBalance: DEFAULT_BACKTEST_STARTING_BALANCE,
      costs,
    }]
  })
}

function normalizeSeries(series: CandleSeries, now: number): Candle[] {
  if (series.interval !== "MIN_10" || series.intervalMs !== TEN_MINUTES_MS) return []
  return completedCandles(series.candles, TEN_MINUTES_MS, now)
}

function uniqueDates(episodes: readonly ReinforcementReplayEpisode[]): string[] {
  return [...new Set(episodes.map((episode) => episode.sessionDate))].sort()
}

function uniqueInstruments(episodes: readonly ReinforcementReplayEpisode[]): string[] {
  return [...new Set(episodes.map((episode) => episode.identity.instrumentUid))]
}

function uniqueDatesFromCandles(candles: readonly Candle[]): string[] {
  return [...new Set(candles.map((candle) => sessionDateAt(candle.timestamp)))].sort()
}

function sessionTime(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+03:00`)
}

const SESSION_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

function sessionDateAt(timestamp: number): string {
  return SESSION_DATE_FORMATTER.format(new Date(timestamp))
}

function resultFromExperiment(
  experiment: ReinforcementExperimentArtifact,
  artifact: ReinforcementPolicyArtifact | null,
  cached: boolean,
): ReinforcementBacktestResult {
  return {
    artifact,
    experiment,
    cached,
    skippedInputs: experiment.skippedInstruments,
    startDate: experiment.manifest.requestedStartDate,
    endDate: experiment.manifest.cutoffDate,
    sessionDates: experiment.eligibleDates,
    instruments: experiment.instruments,
    episodes: experiment.episodes,
    skippedInstruments: experiment.skippedInstruments,
  }
}

export function latestCompletedSessionDate(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const date = `${values.get("year")}-${values.get("month")}-${values.get("day")}`
  const minutes = Number(values.get("hour")) * 60 + Number(values.get("minute"))
  return previousWeekday(date, minutes >= 18 * 60 + 10 ? 0 : 1)
}

function previousWeekday(date: string, daysBack: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  let remaining = daysBack
  while (remaining > 0) {
    value.setUTCDate(value.getUTCDate() - 1)
    if (value.getUTCDay() !== 0 && value.getUTCDay() !== 6) remaining--
  }
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) value.setUTCDate(value.getUTCDate() - 1)
  return value.toISOString().slice(0, 10)
}

function calendarDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++
      const value = values[index]
      if (value === undefined) return
      results[index] = await mapper(value)
    }
  })
  await Promise.all(workers)
  return results
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Reinforcement backtest cancelled", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
