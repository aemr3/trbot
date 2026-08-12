import type { Candle } from "../../market/candle.ts"
import {
  prepareTradingMarketSnapshot,
  type BacktestCosts,
  type MarketRuleSnapshot,
  type PointInTimeMarketSnapshot,
  type UniverseDecisionSnapshot,
} from "../backtest.ts"
import {
  validateReplayEpisode,
  type ReinforcementReplayEpisode,
  type ReplayIdentity,
} from "./replay.ts"

export interface PreparedReplayEvent {
  sequence: number
  decisionIndex: number
  timestamp: number
  nextCandle: Candle
  market: PointInTimeMarketSnapshot
}

export interface PreparedReplayEpisode {
  sessionDate: string
  identity: ReplayIdentity
  rules: MarketRuleSnapshot
  universe: UniverseDecisionSnapshot | null
  startingBalance?: number
  costs?: BacktestCosts
  events: PreparedReplayEvent[]
}

export interface PreparedReplayScheduleEntry {
  timestamp: number
  events: Array<{ episodeIndex: number; eventIndex: number }>
}

export interface PreparedReplaySession {
  sessionDate: string
  episodes: PreparedReplayEpisode[]
  schedule: PreparedReplayScheduleEntry[]
}

export interface PreparedReplayDataset {
  dates: string[]
  episodes: PreparedReplayEpisode[]
  sessions: PreparedReplaySession[]
}

export function prepareReplayDataset(
  episodes: readonly ReinforcementReplayEpisode[],
): PreparedReplayDataset {
  const prepared = episodes.map(prepareEpisode)
  const grouped = new Map<string, PreparedReplayEpisode[]>()
  for (const episode of prepared) {
    const group = grouped.get(episode.sessionDate) ?? []
    group.push(episode)
    grouped.set(episode.sessionDate, group)
  }
  const sessions = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionDate, values]) => prepareSession(sessionDate, values))
  return {
    dates: sessions.map((session) => session.sessionDate),
    episodes: sessions.flatMap((session) => session.episodes),
    sessions,
  }
}

export function filterPreparedReplayDates(
  dataset: PreparedReplayDataset,
  dates: readonly string[],
): PreparedReplaySession[] {
  const included = new Set(dates)
  return dataset.sessions.filter((session) => included.has(session.sessionDate))
}

function prepareEpisode(episode: ReinforcementReplayEpisode): PreparedReplayEpisode {
  validateReplayEpisode(episode)
  return {
    sessionDate: episode.sessionDate,
    identity: { ...episode.identity },
    rules: structuredClone(episode.rules),
    universe: episode.universe ? structuredClone(episode.universe) : null,
    ...(episode.startingBalance === undefined ? {} : { startingBalance: episode.startingBalance }),
    ...(episode.costs === undefined ? {} : { costs: { ...episode.costs } }),
    events: episode.decisionIndexes.map((decisionIndex, sequence) => ({
      sequence,
      decisionIndex,
      timestamp: episode.candles[decisionIndex]!.timestamp,
      nextCandle: { ...episode.candles[decisionIndex + 1]! },
      market: prepareTradingMarketSnapshot(episode.candles, decisionIndex),
    })),
  }
}

function prepareSession(
  sessionDate: string,
  episodes: PreparedReplayEpisode[],
): PreparedReplaySession {
  const ordered = [...episodes].sort((left, right) => left.identity.symbol.localeCompare(right.identity.symbol))
  const instrumentUids = new Set(ordered.map((episode) => episode.identity.instrumentUid))
  if (instrumentUids.size !== ordered.length) {
    throw new Error("Portfolio reinforcement replay contains a duplicate instrument")
  }
  const scheduled = new Map<number, Array<{ episodeIndex: number; eventIndex: number }>>()
  for (let episodeIndex = 0; episodeIndex < ordered.length; episodeIndex++) {
    const episode = ordered[episodeIndex]!
    for (let eventIndex = 0; eventIndex < episode.events.length; eventIndex++) {
      const event = episode.events[eventIndex]!
      const values = scheduled.get(event.timestamp) ?? []
      values.push({ episodeIndex, eventIndex })
      scheduled.set(event.timestamp, values)
    }
  }
  return {
    sessionDate,
    episodes: ordered,
    schedule: [...scheduled.entries()]
      .sort(([left], [right]) => left - right)
      .map(([timestamp, events]) => ({ timestamp, events })),
  }
}
