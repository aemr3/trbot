import type { Candle } from "../../market/candle.ts"
import {
  BACKTEST_MIN_CONTEXT_BARS,
  type BacktestCosts,
  type BacktestDecisionRecord,
  type MarketRuleSnapshot,
  type TradeAction,
  type UniverseDecisionSnapshot,
} from "../backtest.ts"

export interface ReplayIdentity {
  instrumentUid: string
  symbol: string
}

export interface ReinforcementReplayEpisode {
  sessionDate: string
  candles: Candle[]
  decisionIndexes: number[]
  identity: ReplayIdentity
  rules: MarketRuleSnapshot
  universe?: UniverseDecisionSnapshot | null
  startingBalance?: number
  costs?: BacktestCosts
}

export interface ReplayStep {
  decisionIndex: number
  action: TradeAction
  reward: number
  explored: boolean
  record: BacktestDecisionRecord
}

export function validateReplayEpisode(episode: ReinforcementReplayEpisode): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(episode.sessionDate)) {
    throw new Error(`Invalid reinforcement replay date ${episode.sessionDate}`)
  }
  if (episode.decisionIndexes.length === 0) throw new Error("Reinforcement replay has no decisions")
  for (let index = 1; index < episode.candles.length; index++) {
    if (episode.candles[index]!.timestamp <= episode.candles[index - 1]!.timestamp) {
      throw new Error("Reinforcement replay candles must be strictly chronological")
    }
  }
  let previous = -1
  for (const index of episode.decisionIndexes) {
    if (!Number.isInteger(index) || index < BACKTEST_MIN_CONTEXT_BARS - 1 || index >= episode.candles.length - 1) {
      throw new Error(`Invalid reinforcement replay decision index ${index}`)
    }
    if (previous >= 0 && index !== previous + 1) {
      throw new Error("Reinforcement replay decision indexes must be contiguous")
    }
    if (sessionDateAt(episode.candles[index]!.timestamp) !== episode.sessionDate
      || sessionDateAt(episode.candles[index + 1]!.timestamp) !== episode.sessionDate) {
      throw new Error("Reinforcement replay decisions and outcomes must stay inside the requested session")
    }
    previous = index
  }
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
