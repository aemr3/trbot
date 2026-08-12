import type { Candle } from "../market/candle.ts"

export const BACKTEST_TIMEFRAME = "10m" as const
export const BACKTEST_HORIZON_BARS = 3 as const
export const BACKTEST_MIN_CONTEXT_BARS = 20
export const BACKTEST_MAX_CONTEXT_BARS = 60
export const DEFAULT_BACKTEST_STARTING_BALANCE = 20_000

export type TradeAction = "LONG" | "SHORT" | "FLAT"
export type PositionSide = Exclude<TradeAction, "FLAT">
export type PositionTransition = "FLAT" | "OPEN" | "HOLD" | "CLOSE" | "REVERSE"

export interface MarketRuleSnapshot {
  venue: "Borsa Istanbul VIOP"
  capturedAt: number
  expiryDate: string | null
  contractMultiplier: number
  standardEquityContractMultiplier: number
  initialCollateral: number | null
  previousSettlementPrice: number | null
  lowerPriceLimit: number | null
  upperPriceLimit: number | null
  underlyingEquityPriceMarginPercent: number
  equityFutureDailyLimitPercent: number
  equityFutureTickSizeBands: Array<{ minimum: number; maximum: number | null; tick: number }>
  equityDownsideCircuitBreakerPercent: number
  marketWideCircuitBreakerPercent: number
  marketWideHaltMinutesForEquityDerivatives: number
  rulesEffectiveFrom: string
  caveats: string[]
}

export interface IndicatorSnapshot {
  return1: number | null
  return3: number | null
  return6: number | null
  return12: number | null
  sma5: number | null
  sma20: number | null
  priceVsSma5Percent: number | null
  priceVsSma20Percent: number | null
  smaSpreadPercent: number | null
  rsi14: number | null
  atr14: number | null
  atrPercent: number | null
  volumeRatio20: number | null
  realizedVolatility20Percent: number | null
  rangePosition20: number | null
  directionalEfficiency10: number | null
  barCloseLocation: number | null
}

export interface CandleSessionSummary {
  sessionDate: string
  barCount: number
  open: number
  high: number
  low: number
  close: number
  returnPercent: number
  rangePercent: number
  closeLocation: number | null
  totalVolume: number | null
  vwap: number | null
}

export interface TradingSessionSnapshot extends CandleSessionSummary {
  barIndex: number
  minutesFromOpen: number
  gapFromPreviousClosePercent: number | null
  priceVsVwapPercent: number | null
  volumePaceRatio: number | null
  previousSession: CandleSessionSummary | null
}

export interface UniverseDecisionSnapshot {
  selectedSymbols: string[]
  selectionThesis: string
  riskFlags: string[]
}

export interface PriorDecisionSnapshot {
  action: TradeAction
  confidence: number
  netPnl: number
  decisionAt?: number
  transition?: PositionTransition
  thesis?: string
  riskFlags?: string[]
}

export interface StrategyStateSnapshot {
  startingBalance: number
  runningBalance: number
  cumulativeNetPnl: number
  priorPredictions: number
  priorNonFlatTargets: number
  priorPositiveIntervals: number
  priorNegativeIntervals: number
  recentDecisions: PriorDecisionSnapshot[]
}

export interface OpenPositionState {
  instrumentUid: string
  symbol: string
  side: PositionSide
  contracts: 1
  entryAt: number
  entryMarketPrice: number
  entryPrice: number
  entryCosts: number
  markAt: number
  markPrice: number
  contractMultiplier: number
  initialCollateral: number
}

export interface PortfolioPositionSnapshot extends OpenPositionState {
  notional: number
  unrealizedPnl: number
  holdingBars: number
  holdingMinutes: number
}

export interface PortfolioStateSnapshot {
  asOf: number
  startingBalance: number
  equity: number
  realizedPnl: number
  unrealizedPnl: number
  reservedCollateral: number
  availableBalance: number
  grossNotional: number
  netDirectionalNotional: number
  positions: PortfolioPositionSnapshot[]
  closedPositions: ClosedPositionSnapshot[]
}

export interface CollateralSnapshot {
  totalBalance: number
  usedBalance: number
  availableBalance: number
  requiredForOneContract: number | null
  usedByThisContract: number
  canOpenFromFlat: boolean
}

export interface TradingContextState {
  universe: UniverseDecisionSnapshot | null
  priorDecisions: PriorDecisionSnapshot[]
  startingBalance: number
  portfolio: PortfolioStateSnapshot | null
  strategyState: StrategyStateSnapshot | null
}

export interface TradingContext {
  instrumentUid: string
  symbol: string
  timeframe: typeof BACKTEST_TIMEFRAME
  horizonBars: typeof BACKTEST_HORIZON_BARS
  asOf: number
  candles: Candle[]
  indicators: IndicatorSnapshot
  session: TradingSessionSnapshot
  universe: UniverseDecisionSnapshot | null
  strategyState: StrategyStateSnapshot
  portfolio: PortfolioStateSnapshot
  collateral: CollateralSnapshot
  rules: MarketRuleSnapshot
  costs: BacktestCosts
}

export interface PointInTimeMarketSnapshot {
  asOf: number
  candles: Candle[]
  indicators: IndicatorSnapshot
  session: TradingSessionSnapshot
}

export interface TradingDecision {
  action: TradeAction
  confidence: number
  thesis: string
  riskFlags: string[]
}

export interface InstrumentDecision extends TradingDecision {
  instrumentUid: string
}

export interface CollateralDecisionInput {
  context: TradingContext
  position: OpenPositionState | null
  decision: InstrumentDecision
}

export interface BacktestCosts {
  slippageBpsPerSide: number
  commissionBpsPerSide: number
}

export const DEFAULT_BACKTEST_COSTS: BacktestCosts = {
  slippageBpsPerSide: 2,
  commissionBpsPerSide: 0,
}

export function enforceCollateralBudget(
  portfolio: PortfolioStateSnapshot,
  inputs: CollateralDecisionInput[],
): InstrumentDecision[] {
  const inputPositionCollateral = sum(inputs.map((input) => input.position?.initialCollateral ?? 0))
  let available = portfolio.equity - Math.max(0, portfolio.reservedCollateral - inputPositionCollateral)
  const accepted = new Map<string, InstrumentDecision>()
  const allocations: CollateralDecisionInput[] = []

  for (const input of inputs) {
    if (input.decision.instrumentUid !== input.context.instrumentUid) {
      throw new Error(`Collateral decision does not match ${input.context.symbol}`)
    }
    if (input.decision.action === "FLAT") {
      accepted.set(input.context.instrumentUid, input.decision)
    } else if (input.position?.side === input.decision.action) {
      available -= input.position.initialCollateral
      accepted.set(input.context.instrumentUid, input.decision)
    } else {
      allocations.push(input)
    }
  }

  allocations.sort((left, right) => right.decision.confidence - left.decision.confidence)
  for (const input of allocations) {
    const required = input.context.collateral.requiredForOneContract
    if (required !== null && required <= Math.max(0, available)) {
      available -= required
      accepted.set(input.context.instrumentUid, input.decision)
      continue
    }
    const availableBeforeOrder = Math.max(0, available)
    const collateralRisk = required === null
      ? "Collateral blocked: exchange initial collateral is unavailable"
      : `Collateral blocked: required ${required.toFixed(2)}, available ${availableBeforeOrder.toFixed(2)}`
    accepted.set(input.context.instrumentUid, {
      ...input.decision,
      action: "FLAT",
      thesis: `Collateral guard changed ${input.decision.action} to FLAT. ${input.decision.thesis}`.slice(0, 280),
      riskFlags: [
        collateralRisk,
        ...input.decision.riskFlags,
      ].slice(0, 5),
    })
  }

  return inputs.map((input) => accepted.get(input.context.instrumentUid)!)
}

export interface SimulatedDecisionResult {
  decisionAt: number
  entryAt: number
  action: TradeAction
  confidence: number
  transition: PositionTransition
  positionBefore: TradeAction
  positionAfter: TradeAction
  sessionClosed: boolean
  entryPrice: number | null
  exitPrice: number | null
  grossPnl: number
  costs: number
  netPnl: number
  returnPercent: number
  closedTrades: ClosedTradeResult[]
}

export interface ClosedTradeResult {
  side: PositionSide
  entryAt: number
  exitAt: number
  holdingMinutes: number
  entryMarketPrice: number
  exitMarketPrice: number
  entryPrice: number
  exitPrice: number
  grossPnl: number
  costs: number
  netPnl: number
  reason: "SIGNAL" | "SESSION_END"
}

export interface ClosedPositionSnapshot extends ClosedTradeResult {
  instrumentUid: string
  symbol: string
}

export interface BacktestMetrics {
  startBalance: number
  endBalance: number
  predictions: number
  trades: number
  wins: number
  losses: number
  flatSignals: number
  winRate: number
  grossPnl: number
  costs: number
  netPnl: number
  returnPercent: number
  maxDrawdown: number
  profitFactor: number | null
}

export interface BacktestDecisionRecord {
  context: TradingContext
  decision: TradingDecision
  result: SimulatedDecisionResult
}

interface ContextIdentity {
  instrumentUid: string
  symbol: string
}

export function completedCandles(candles: Candle[], intervalMs: number, now: number): Candle[] {
  return candles
    .filter((candle) => candle.timestamp + intervalMs <= now)
    .filter(isValidCandle)
    .sort((left, right) => left.timestamp - right.timestamp)
}

export function buildTradingContext(
  candles: Candle[],
  decisionIndex: number,
  identity: ContextIdentity,
  rules: MarketRuleSnapshot,
  state: Partial<TradingContextState> = {},
  costs: BacktestCosts = DEFAULT_BACKTEST_COSTS,
): TradingContext {
  return buildTradingContextFromSnapshot(
    prepareTradingMarketSnapshot(candles, decisionIndex),
    identity,
    rules,
    state,
    costs,
  )
}

export function prepareTradingMarketSnapshot(
  candles: Candle[],
  decisionIndex: number,
): PointInTimeMarketSnapshot {
  if (decisionIndex < BACKTEST_MIN_CONTEXT_BARS - 1 || decisionIndex >= candles.length) {
    throw new Error("Backtest decision does not have enough point-in-time candle history")
  }
  const history = candles.slice(0, decisionIndex + 1)
  const contextCandles = history.slice(-BACKTEST_MAX_CONTEXT_BARS).map((candle) => ({ ...candle }))
  const current = history.at(-1)
  if (!current) throw new Error("Backtest decision candle is missing")
  return {
    asOf: current.timestamp,
    candles: contextCandles,
    indicators: calculateIndicatorSnapshot(history),
    session: calculateSessionSnapshot(history),
  }
}

export function buildTradingContextFromSnapshot(
  market: PointInTimeMarketSnapshot,
  identity: ContextIdentity,
  rules: MarketRuleSnapshot,
  state: Partial<TradingContextState> = {},
  costs: BacktestCosts = DEFAULT_BACKTEST_COSTS,
): TradingContext {
  const current = market.candles.at(-1)
  if (!current) throw new Error("Backtest market snapshot has no candles")
  const startingBalance = positiveFinite(state.startingBalance)
    ?? positiveFinite(rules.initialCollateral)
    ?? current.close * rules.contractMultiplier
  const priorDecisions = state.priorDecisions ?? []
  const cumulativeNetPnl = sum(priorDecisions.map((decision) => decision.netPnl))
  const portfolio = state.portfolio ?? emptyPortfolioSnapshot(current.timestamp, startingBalance)
  const requiredForOneContract = positiveFinite(rules.initialCollateral)
  const usedByThisContract = portfolio.positions.find(
    (position) => position.instrumentUid === identity.instrumentUid,
  )?.initialCollateral ?? 0
  const strategyState = state.strategyState ?? {
    startingBalance,
    runningBalance: startingBalance + cumulativeNetPnl,
    cumulativeNetPnl,
    priorPredictions: priorDecisions.length,
    priorNonFlatTargets: priorDecisions.filter((decision) => decision.action !== "FLAT").length,
    priorPositiveIntervals: priorDecisions.filter((decision) => decision.netPnl > 0).length,
    priorNegativeIntervals: priorDecisions.filter((decision) => decision.netPnl < 0).length,
    recentDecisions: priorDecisions.slice(-5).map((decision) => ({ ...decision })),
  }

  return {
    instrumentUid: identity.instrumentUid,
    symbol: identity.symbol,
    timeframe: BACKTEST_TIMEFRAME,
    horizonBars: BACKTEST_HORIZON_BARS,
    asOf: market.asOf,
    candles: market.candles,
    indicators: market.indicators,
    session: market.session,
    universe: state.universe ?? null,
    strategyState,
    portfolio,
    collateral: {
      totalBalance: portfolio.equity,
      usedBalance: portfolio.reservedCollateral,
      availableBalance: portfolio.availableBalance,
      requiredForOneContract,
      usedByThisContract,
      canOpenFromFlat: requiredForOneContract !== null && portfolio.availableBalance >= requiredForOneContract,
    },
    rules,
    costs,
  }
}

export function simulatePositionDecision(
  context: TradingContext,
  decision: TradingDecision,
  nextCandle: Candle,
  position: OpenPositionState | null,
  costs: BacktestCosts = DEFAULT_BACKTEST_COSTS,
  forceSessionClose = false,
): { result: SimulatedDecisionResult; position: OpenPositionState | null } {
  const confidence = clamp(decision.confidence, 0, 1)
  const current = context.candles.at(-1)
  if (!current) throw new Error("Position decision context has no current candle")
  const multiplier = context.rules.contractMultiplier
  const positionBefore = position?.side ?? "FLAT"
  const transition = positionTransition(positionBefore, decision.action)
  const closedTrades: ClosedTradeResult[] = []
  let grossPnl = 0
  let netPnl = 0
  let entryPrice: number | null = null
  let exitPrice: number | null = null
  let nextPosition = position ? { ...position } : null
  let sessionClosed = false

  if (position && decision.action === position.side) {
    grossPnl = direction(position.side) * (nextCandle.close - current.close) * multiplier
    netPnl = grossPnl
    nextPosition = markedPosition(position, nextCandle)
  } else if (position && decision.action === "FLAT") {
    const fill = executionPrice(nextCandle.open, closeOrderSide(position.side), costs, context.rules)
    const commission = executionCommission(fill, multiplier, costs)
    grossPnl = direction(position.side) * (nextCandle.open - current.close) * multiplier
    netPnl = direction(position.side) * (fill - current.close) * multiplier - commission
    exitPrice = fill
    closedTrades.push(closedTrade(position, nextCandle.open, fill, nextCandle.timestamp, commission, "SIGNAL"))
    nextPosition = null
  } else if (position && decision.action !== "FLAT") {
    const closingFill = executionPrice(nextCandle.open, closeOrderSide(position.side), costs, context.rules)
    const closingCommission = executionCommission(closingFill, multiplier, costs)
    const openingFill = executionPrice(nextCandle.open, openOrderSide(decision.action), costs, context.rules)
    const openingCommission = executionCommission(openingFill, multiplier, costs)
    grossPnl = direction(position.side) * (nextCandle.open - current.close) * multiplier
      + direction(decision.action) * (nextCandle.close - nextCandle.open) * multiplier
    netPnl = direction(position.side) * (closingFill - current.close) * multiplier - closingCommission
      + direction(decision.action) * (nextCandle.close - openingFill) * multiplier - openingCommission
    entryPrice = openingFill
    exitPrice = closingFill
    closedTrades.push(closedTrade(
      position,
      nextCandle.open,
      closingFill,
      nextCandle.timestamp,
      closingCommission,
      "SIGNAL",
    ))
    nextPosition = newPosition(context, decision.action, openingFill, openingCommission, nextCandle)
  } else if (!position && decision.action !== "FLAT") {
    const fill = executionPrice(nextCandle.open, openOrderSide(decision.action), costs, context.rules)
    const commission = executionCommission(fill, multiplier, costs)
    grossPnl = direction(decision.action) * (nextCandle.close - nextCandle.open) * multiplier
    netPnl = direction(decision.action) * (nextCandle.close - fill) * multiplier - commission
    entryPrice = fill
    nextPosition = newPosition(context, decision.action, fill, commission, nextCandle)
  }

  if (forceSessionClose && nextPosition) {
    sessionClosed = true
    const fill = executionPrice(nextCandle.close, closeOrderSide(nextPosition.side), costs, context.rules)
    const commission = executionCommission(fill, multiplier, costs)
    netPnl += direction(nextPosition.side) * (fill - nextCandle.close) * multiplier - commission
    exitPrice = fill
    closedTrades.push(closedTrade(
      nextPosition,
      nextCandle.close,
      fill,
      nextCandle.timestamp,
      commission,
      "SESSION_END",
    ))
    nextPosition = null
  }

  const denominator = context.portfolio.equity > 0 ? context.portfolio.equity : current.close * multiplier
  return {
    result: {
      decisionAt: context.asOf,
      entryAt: nextCandle.timestamp,
      action: decision.action,
      confidence,
      transition,
      positionBefore,
      positionAfter: nextPosition?.side ?? "FLAT",
      sessionClosed,
      entryPrice,
      exitPrice,
      grossPnl,
      costs: grossPnl - netPnl,
      netPnl,
      returnPercent: denominator > 0 ? (netPnl / denominator) * 100 : 0,
      closedTrades,
    },
    position: nextPosition,
  }
}

export function calculateBacktestMetrics(
  records: BacktestDecisionRecord[],
  capitalBase: number,
): BacktestMetrics {
  const closedTrades = records.flatMap((record) => record.result.closedTrades)
  const wins = closedTrades.filter((trade) => trade.netPnl > 0)
  const losses = closedTrades.filter((trade) => trade.netPnl < 0)
  const grossPnl = sum(records.map((record) => record.result.grossPnl))
  const costs = sum(records.map((record) => record.result.costs))
  const netPnl = sum(records.map((record) => record.result.netPnl))
  const grossProfit = sum(wins.map((trade) => trade.netPnl))
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.netPnl)))
  const startBalance = Math.max(0, capitalBase)
  let equity = startBalance
  let peak = equity
  let maxDrawdown = 0
  const pnlByEntryAt = new Map<number, number>()

  for (const record of records) {
    pnlByEntryAt.set(record.result.entryAt, (pnlByEntryAt.get(record.result.entryAt) ?? 0) + record.result.netPnl)
  }
  for (const [, pnl] of [...pnlByEntryAt].sort((left, right) => left[0] - right[0])) {
    equity += pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }

  return {
    startBalance,
    endBalance: startBalance + netPnl,
    predictions: records.length,
    trades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    flatSignals: records.filter((record) => record.decision.action === "FLAT").length,
    winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
    grossPnl,
    costs,
    netPnl,
    returnPercent: capitalBase > 0 ? (netPnl / capitalBase) * 100 : 0,
    maxDrawdown,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
  }
}

export function calculateIndicatorSnapshot(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((candle) => candle.close)
  const current = closes.at(-1)
  const sma5 = average(closes.slice(-5), 5)
  const sma20 = average(closes.slice(-20), 20)
  const atr14 = atr(candles, 14)
  return {
    return1: percentageReturn(closes, 1),
    return3: percentageReturn(closes, 3),
    return6: percentageReturn(closes, 6),
    return12: percentageReturn(closes, 12),
    sma5,
    sma20,
    priceVsSma5Percent: percentageDifference(current, sma5),
    priceVsSma20Percent: percentageDifference(current, sma20),
    smaSpreadPercent: percentageDifference(sma5, sma20),
    rsi14: rsi(closes, 14),
    atr14,
    atrPercent: percentageOfPrice(atr14, current),
    volumeRatio20: volumeRatio(candles, 20),
    realizedVolatility20Percent: realizedVolatility(closes, 20),
    rangePosition20: rangePosition(candles, 20),
    directionalEfficiency10: directionalEfficiency(closes, 10),
    barCloseLocation: candleCloseLocation(candles.at(-1)),
  }
}

export function summarizeSession(candles: Candle[]): CandleSessionSummary | null {
  const first = candles[0]
  const last = candles.at(-1)
  if (!first || !last) return null
  const high = Math.max(...candles.map((candle) => candle.high))
  const low = Math.min(...candles.map((candle) => candle.low))
  const volumes = candles.map((candle) => candle.volume).filter((value): value is number => value !== null)
  const totalVolume = volumes.length > 0 ? sum(volumes) : null
  const weighted = candles.filter((candle): candle is Candle & { volume: number } => candle.volume !== null)
  const weightedVolume = sum(weighted.map((candle) => candle.volume))
  const vwap = weightedVolume > 0
    ? sum(weighted.map((candle) => ((candle.high + candle.low + candle.close) / 3) * candle.volume)) / weightedVolume
    : null
  return {
    sessionDate: sessionDateAt(first.timestamp),
    barCount: candles.length,
    open: first.open,
    high,
    low,
    close: last.close,
    returnPercent: percentageDifference(last.close, first.open) ?? 0,
    rangePercent: percentageOfPrice(high - low, first.open) ?? 0,
    closeLocation: positionInRange(last.close, low, high),
    totalVolume,
    vwap,
  }
}

export function buildPortfolioSnapshot(
  asOf: number,
  startingBalance: number,
  cumulativeNetPnl: number,
  realizedPnl: number,
  positions: OpenPositionState[],
  closedPositions: ClosedPositionSnapshot[] = [],
): PortfolioStateSnapshot {
  const snapshots = positions.map((position): PortfolioPositionSnapshot => {
    const notional = position.markPrice * position.contractMultiplier * position.contracts
    const holdingBars = Math.max(1, Math.floor((position.markAt - position.entryAt) / (10 * 60_000)) + 1)
    return {
      ...position,
      notional,
      unrealizedPnl: direction(position.side) * (position.markPrice - position.entryPrice)
        * position.contractMultiplier * position.contracts - position.entryCosts,
      holdingBars,
      holdingMinutes: holdingBars * 10,
    }
  })
  const equity = startingBalance + cumulativeNetPnl
  const reservedCollateral = sum(snapshots.map((position) => position.initialCollateral))
  return {
    asOf,
    startingBalance,
    equity,
    realizedPnl,
    unrealizedPnl: sum(snapshots.map((position) => position.unrealizedPnl)),
    reservedCollateral,
    availableBalance: equity - reservedCollateral,
    grossNotional: sum(snapshots.map((position) => position.notional)),
    netDirectionalNotional: sum(snapshots.map((position) => direction(position.side) * position.notional)),
    positions: snapshots,
    closedPositions: closedPositions.map((position) => ({ ...position })),
  }
}

function emptyPortfolioSnapshot(asOf: number, startingBalance: number): PortfolioStateSnapshot {
  return buildPortfolioSnapshot(asOf, startingBalance, 0, 0, [])
}

function positionTransition(before: TradeAction, target: TradeAction): PositionTransition {
  if (before === "FLAT") return target === "FLAT" ? "FLAT" : "OPEN"
  if (target === "FLAT") return "CLOSE"
  return before === target ? "HOLD" : "REVERSE"
}

function newPosition(
  context: TradingContext,
  side: PositionSide,
  entryPrice: number,
  entryCosts: number,
  candle: Candle,
): OpenPositionState {
  return {
    instrumentUid: context.instrumentUid,
    symbol: context.symbol,
    side,
    contracts: 1,
    entryAt: candle.timestamp,
    entryMarketPrice: candle.open,
    entryPrice,
    entryCosts,
    markAt: candle.timestamp,
    markPrice: candle.close,
    contractMultiplier: context.rules.contractMultiplier,
    initialCollateral: requiredCollateral(context),
  }
}

function requiredCollateral(context: TradingContext): number {
  const collateral = context.collateral.requiredForOneContract
  if (collateral === null) throw new Error(`Initial collateral is unavailable for ${context.symbol}`)
  return collateral
}

function markedPosition(position: OpenPositionState, candle: Candle): OpenPositionState {
  return { ...position, markAt: candle.timestamp, markPrice: candle.close }
}

function closedTrade(
  position: OpenPositionState,
  exitMarketPrice: number,
  exitPrice: number,
  exitAt: number,
  exitCommission: number,
  reason: ClosedTradeResult["reason"],
): ClosedTradeResult {
  const grossPnl = direction(position.side) * (exitMarketPrice - position.entryMarketPrice)
    * position.contractMultiplier * position.contracts
  const netPnl = direction(position.side) * (exitPrice - position.entryPrice)
    * position.contractMultiplier * position.contracts - position.entryCosts - exitCommission
  return {
    side: position.side,
    entryAt: position.entryAt,
    exitAt,
    holdingMinutes: Math.max(0, (exitAt - position.entryAt) / 60_000),
    entryMarketPrice: position.entryMarketPrice,
    exitMarketPrice,
    entryPrice: position.entryPrice,
    exitPrice,
    grossPnl,
    costs: grossPnl - netPnl,
    netPnl,
    reason,
  }
}

function executionPrice(
  basePrice: number,
  side: "BUY" | "SELL",
  costs: BacktestCosts,
  rules: MarketRuleSnapshot,
): number {
  const slippage = Math.max(0, costs.slippageBpsPerSide) / 10_000
  const adjusted = basePrice * (side === "BUY" ? 1 + slippage : 1 - slippage)
  return boundedPrice(adjusted, rules.lowerPriceLimit, rules.upperPriceLimit)
}

function executionCommission(price: number, multiplier: number, costs: BacktestCosts): number {
  return price * multiplier * (Math.max(0, costs.commissionBpsPerSide) / 10_000)
}

function openOrderSide(side: PositionSide): "BUY" | "SELL" {
  return side === "LONG" ? "BUY" : "SELL"
}

function closeOrderSide(side: PositionSide): "BUY" | "SELL" {
  return side === "LONG" ? "SELL" : "BUY"
}

function direction(side: PositionSide): 1 | -1 {
  return side === "LONG" ? 1 : -1
}

function calculateSessionSnapshot(history: Candle[]): TradingSessionSnapshot {
  const current = history.at(-1)!
  const currentDate = sessionDateAt(current.timestamp)
  const sessionStartIndex = history.findIndex((candle) => sessionDateAt(candle.timestamp) === currentDate)
  const sessionCandles = history.slice(sessionStartIndex)
  const previousCandles = history.slice(0, sessionStartIndex)
  const previousDate = previousCandles.at(-1) ? sessionDateAt(previousCandles.at(-1)!.timestamp) : null
  const previousSession = previousDate
    ? summarizeSession(previousCandles.filter((candle) => sessionDateAt(candle.timestamp) === previousDate))
    : null
  const summary = summarizeSession(sessionCandles)!
  const currentAverageVolume = averageVolume(sessionCandles)
  const previousAverageVolume = previousSession?.totalVolume === null || previousSession?.totalVolume === undefined
    ? null
    : previousSession.totalVolume / previousSession.barCount
  return {
    ...summary,
    barIndex: sessionCandles.length - 1,
    minutesFromOpen: (current.timestamp - sessionCandles[0]!.timestamp) / 60_000,
    gapFromPreviousClosePercent: previousSession ? percentageDifference(summary.open, previousSession.close) : null,
    priceVsVwapPercent: percentageDifference(summary.close, summary.vwap),
    volumePaceRatio: currentAverageVolume !== null && previousAverageVolume && previousAverageVolume > 0
      ? currentAverageVolume / previousAverageVolume
      : null,
    previousSession,
  }
}

function percentageReturn(values: number[], periods: number): number | null {
  const current = values.at(-1)
  const previous = values.at(-(periods + 1))
  if (current === undefined || previous === undefined || previous === 0) return null
  return ((current / previous) - 1) * 100
}

function average(values: number[], required: number): number | null {
  if (values.length < required) return null
  return sum(values) / values.length
}

function rsi(closes: number[], periods: number): number | null {
  if (closes.length <= periods) return null
  const window = closes.slice(-(periods + 1))
  let gains = 0
  let losses = 0
  for (let index = 1; index < window.length; index++) {
    const change = (window[index] ?? 0) - (window[index - 1] ?? 0)
    if (change >= 0) gains += change
    else losses -= change
  }
  const averageGain = gains / periods
  const averageLoss = losses / periods
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100
  return 100 - 100 / (1 + averageGain / averageLoss)
}

function atr(candles: Candle[], periods: number): number | null {
  if (candles.length <= periods) return null
  const window = candles.slice(-(periods + 1))
  const trueRanges: number[] = []
  for (let index = 1; index < window.length; index++) {
    const candle = window[index]
    const previous = window[index - 1]
    if (!candle || !previous) continue
    trueRanges.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close)))
  }
  return average(trueRanges, periods)
}

function volumeRatio(candles: Candle[], periods: number): number | null {
  const volumes = candles.slice(-(periods + 1), -1).map((candle) => candle.volume).filter((value): value is number => value !== null)
  const current = candles.at(-1)?.volume
  if (current === null || current === undefined || volumes.length < periods) return null
  const baseline = sum(volumes) / volumes.length
  return baseline > 0 ? current / baseline : null
}

function realizedVolatility(closes: number[], periods: number): number | null {
  if (closes.length <= periods) return null
  const window = closes.slice(-(periods + 1))
  const returns = window.slice(1).map((value, index) => ((value / window[index]!) - 1) * 100)
  const mean = sum(returns) / returns.length
  const variance = sum(returns.map((value) => (value - mean) ** 2)) / returns.length
  return Math.sqrt(variance)
}

function rangePosition(candles: Candle[], periods: number): number | null {
  if (candles.length < periods) return null
  const window = candles.slice(-periods)
  const current = window.at(-1)
  if (!current) return null
  return positionInRange(
    current.close,
    Math.min(...window.map((candle) => candle.low)),
    Math.max(...window.map((candle) => candle.high)),
  )
}

function directionalEfficiency(closes: number[], periods: number): number | null {
  if (closes.length <= periods) return null
  const window = closes.slice(-(periods + 1))
  const net = window.at(-1)! - window[0]!
  const path = sum(window.slice(1).map((value, index) => Math.abs(value - window[index]!)))
  return path > 0 ? net / path : 0
}

function candleCloseLocation(candle: Candle | undefined): number | null {
  return candle ? positionInRange(candle.close, candle.low, candle.high) : null
}

function positionInRange(value: number, low: number, high: number): number | null {
  return high > low ? (value - low) / (high - low) : null
}

function percentageDifference(value: number | null | undefined, base: number | null | undefined): number | null {
  if (value === null || value === undefined || base === null || base === undefined || base === 0) return null
  return ((value / base) - 1) * 100
}

function percentageOfPrice(value: number | null | undefined, price: number | null | undefined): number | null {
  if (value === null || value === undefined || price === null || price === undefined || price === 0) return null
  return (value / price) * 100
}

function averageVolume(candles: Candle[]): number | null {
  const values = candles.map((candle) => candle.volume).filter((value): value is number => value !== null)
  return values.length > 0 ? sum(values) / values.length : null
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

const SESSION_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

function sessionDateAt(timestamp: number): string {
  const values = new Map(SESSION_DATE_FORMATTER.formatToParts(timestamp).map((part) => [part.type, part.value]))
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`
}

function boundedPrice(value: number, lower: number | null, upper: number | null): number {
  return Math.min(upper ?? Number.POSITIVE_INFINITY, Math.max(lower ?? Number.NEGATIVE_INFINITY, value))
}

function isValidCandle(candle: Candle): boolean {
  return [candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    && candle.open > 0
    && candle.high >= candle.low
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
