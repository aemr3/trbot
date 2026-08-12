import type {
  TradingContext,
  OpenPositionState,
} from "../backtest.ts"

export const REINFORCEMENT_FEATURE_NAMES = [
  "return_1",
  "return_3",
  "return_6",
  "return_12",
  "price_vs_sma_5",
  "price_vs_sma_20",
  "sma_spread",
  "rsi_14",
  "atr_percent",
  "volume_ratio_20",
  "realized_volatility_20",
  "range_position_20",
  "directional_efficiency_10",
  "bar_close_location",
  "session_return",
  "session_range",
  "session_close_location",
  "gap_from_previous_close",
  "price_vs_vwap",
  "volume_pace",
  "session_progress",
  "equity_return",
  "realized_pnl",
  "unrealized_pnl",
  "available_balance",
  "reserved_collateral",
  "gross_notional",
  "net_notional",
  "position_flat",
  "position_long",
  "position_short",
  "position_unrealized_pnl",
  "position_holding_time",
  "required_collateral",
  "can_open",
  "indicator_completeness",
] as const

export type ReinforcementFeatureName = (typeof REINFORCEMENT_FEATURE_NAMES)[number]

export interface ReinforcementState {
  asOf: number
  values: number[]
}

export function extractReinforcementState(
  context: TradingContext,
  position: OpenPositionState | null,
): ReinforcementState {
  const { indicators, session, portfolio, collateral } = context
  const startingBalance = Math.max(1, portfolio.startingBalance)
  const equity = Math.max(1, portfolio.equity)
  const portfolioPosition = portfolio.positions.find((candidate) => candidate.instrumentUid === context.instrumentUid)
  const currentSide = position?.side ?? portfolioPosition?.side ?? "FLAT"
  const indicatorValues = [
    indicators.return1,
    indicators.return3,
    indicators.return6,
    indicators.return12,
    indicators.priceVsSma5Percent,
    indicators.priceVsSma20Percent,
    indicators.smaSpreadPercent,
    indicators.rsi14,
    indicators.atrPercent,
    indicators.volumeRatio20,
    indicators.realizedVolatility20Percent,
    indicators.rangePosition20,
    indicators.directionalEfficiency10,
    indicators.barCloseLocation,
  ]

  const values = [
    scaledPercent(indicators.return1, 2),
    scaledPercent(indicators.return3, 4),
    scaledPercent(indicators.return6, 6),
    scaledPercent(indicators.return12, 10),
    scaledPercent(indicators.priceVsSma5Percent, 4),
    scaledPercent(indicators.priceVsSma20Percent, 8),
    scaledPercent(indicators.smaSpreadPercent, 6),
    centered(indicators.rsi14, 50, 50),
    positiveScale(indicators.atrPercent, 5),
    centered(indicators.volumeRatio20, 1, 3),
    positiveScale(indicators.realizedVolatility20Percent, 5),
    unitIntervalToSigned(indicators.rangePosition20),
    bounded(indicators.directionalEfficiency10 ?? 0),
    unitIntervalToSigned(indicators.barCloseLocation),
    scaledPercent(session.returnPercent, 8),
    positiveScale(session.rangePercent, 10),
    unitIntervalToSigned(session.closeLocation),
    scaledPercent(session.gapFromPreviousClosePercent, 8),
    scaledPercent(session.priceVsVwapPercent, 6),
    centered(session.volumePaceRatio, 1, 3),
    bounded(session.minutesFromOpen / 510),
    bounded(((portfolio.equity / startingBalance) - 1) / 0.1),
    bounded(portfolio.realizedPnl / (startingBalance * 0.05)),
    bounded(portfolio.unrealizedPnl / (startingBalance * 0.05)),
    bounded(portfolio.availableBalance / equity),
    bounded(portfolio.reservedCollateral / equity),
    bounded(portfolio.grossNotional / (equity * 10)),
    bounded(portfolio.netDirectionalNotional / (equity * 10)),
    currentSide === "FLAT" ? 1 : 0,
    currentSide === "LONG" ? 1 : 0,
    currentSide === "SHORT" ? 1 : 0,
    bounded((portfolioPosition?.unrealizedPnl ?? 0) / (startingBalance * 0.02)),
    bounded((portfolioPosition?.holdingMinutes ?? 0) / 180),
    bounded((collateral.requiredForOneContract ?? equity) / equity),
    collateral.canOpenFromFlat ? 1 : 0,
    indicatorValues.filter((value) => value !== null && Number.isFinite(value)).length / indicatorValues.length,
  ].map(bounded)

  if (values.length !== REINFORCEMENT_FEATURE_NAMES.length) {
    throw new Error("Reinforcement feature definition is inconsistent")
  }
  return { asOf: context.asOf, values }
}

function scaledPercent(value: number | null, scale: number): number {
  return value === null ? 0 : bounded(value / scale)
}

function positiveScale(value: number | null, scale: number): number {
  return value === null ? 0 : bounded(value / scale)
}

function centered(value: number | null, midpoint: number, scale: number): number {
  return value === null ? 0 : bounded((value - midpoint) / scale)
}

function unitIntervalToSigned(value: number | null): number {
  return value === null ? 0 : bounded(value * 2 - 1)
}

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}
