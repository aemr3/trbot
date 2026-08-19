import {
  ALERT_BASES,
  ALERT_KINDS,
  ALERT_REPEATS,
  ALERT_STATUSES,
  validatePriceAlert,
  type PriceAlertDraft,
  type PriceAlertStatus,
} from "@trbot/market/alert.ts"
import type { AiModelChoice, AiPreferences } from "@trbot/protocol/ai.ts"
import type { BrokerageDateRange } from "@trbot/market/broker-calendar.ts"
import type { BrokerageSide } from "@trbot/market/brokerage.ts"
import { LEVEL_DIRECTIONS } from "@trbot/market/price-level.ts"
import {
  STOP_POSITION_SIDES,
  STOP_RULE_BASES,
  STOP_RULE_KINDS,
  STOP_RULE_ROLES,
  STOP_RULE_STATUSES,
  validateStopRule,
  type StopRuleDraft,
  type StopRuleStatus,
} from "@trbot/trading/stop.ts"
import {
  CANDLE_CHART_TARGETS,
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  DEFAULT_INTERVALS_BY_RANGE,
  isCandleChartTarget,
  isCandleInterval,
  isCandleRange,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
} from "@trbot/market/candle.ts"
import { isChartIndicator, type ChartIndicator } from "@trbot/market/indicator.ts"
import { OVERVIEW_MODES, type OverviewMode, type StoredOverviewSnapshot } from "@trbot/market/overview.ts"
import {
  INSTRUMENT_SORTS,
  SORT_DIRECTIONS,
  normalizeAppPreferences,
  type AppPreferences,
} from "@trbot/preferences/app.ts"
import type { SettlementMode } from "@trbot/market/settlement.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { isPortfolioRange, type PortfolioRange } from "@trbot/trading/account.ts"
import { VIOP_ORDER_KINDS, type ViopOrderSide } from "@trbot/trading/order.ts"

function invalid(field: string, detail: string): ProtocolError {
  return new ProtocolError("invalid_request", `"${field}" ${detail}`)
}

export function orderSide(value: unknown, field = "side"): ViopOrderSide {
  if (value !== "BUY" && value !== "SELL") throw invalid(field, "must be BUY or SELL")
  return value
}

export function brokerageSide(value: unknown, field = "side"): BrokerageSide {
  if (value !== "BUYER" && value !== "SELLER") throw invalid(field, "must be BUYER or SELLER")
  return value
}

export function settlementMode(value: unknown, field = "mode"): SettlementMode {
  if (value !== "HELD" && value !== "GAINED" && value !== "LOST") {
    throw invalid(field, "must be HELD, GAINED or LOST")
  }
  return value
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(field, "is required")
  return value
}

export function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(field, "must be a number greater than zero")
  }
  return value
}

export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(field, "must be an array of strings")
  }
  return value as string[]
}

export function dateRange(value: unknown, field = "range"): BrokerageDateRange {
  if (!value || typeof value !== "object") throw invalid(field, "must be an object")
  const { start, end } = value as { start?: unknown; end?: unknown }
  const check = (entry: unknown, name: string): string | null => {
    if (entry === null || entry === undefined) return null
    if (typeof entry !== "string") throw invalid(`${field}.${name}`, "must be a string or null")
    return entry
  }
  return { start: check(start, "start"), end: check(end, "end") }
}

export function portfolioRange(value: string | null): PortfolioRange | undefined {
  if (value === null) return undefined
  if (!isPortfolioRange(value)) throw invalid("portfolioRange", "is not a known range")
  return value
}

export function chartTarget(value: string | null): CandleChartTarget | undefined {
  if (value === null) return undefined
  if (!isCandleChartTarget(value)) throw invalid("target", "is not a known chart target")
  return value
}

/**
 * Candle requests carry a range and an interval that must go together — the
 * provider rejects a mismatched pair, so it is caught here with a clearer
 * message than the upstream one.
 */
export function candleSelection(rangeValue: string | null, intervalValue: string | null): {
  range: CandleRange
  interval: CandleInterval
} {
  if (!rangeValue || !isCandleRange(rangeValue)) throw invalid("range", "is not a known candle range")
  if (!intervalValue || !isCandleInterval(intervalValue)) throw invalid("interval", "is not a known candle interval")
  if (!DEFAULT_INTERVALS_BY_RANGE[rangeValue].includes(intervalValue)) {
    throw invalid("interval", `is not available for the ${rangeValue} range`)
  }
  return { range: rangeValue, interval: intervalValue }
}

/**
 * The digest is built by the client and reaches the model as data, so only the
 * one field the server branches on is checked here.
 */
export function overviewMode(value: unknown): OverviewMode {
  if (!OVERVIEW_MODES.some((mode) => mode === value)) throw invalid("mode", "is not a known overview mode")
  return value as OverviewMode
}

/** One of a fixed set, named in the message so a client can see what it may send. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.some((option) => option === value)) throw invalid(field, `must be one of ${allowed.join(", ")}`)
  return value as T
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(field, "must be a number")
  return value
}

function optionalInterval(value: unknown, field: string): CandleInterval | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !isCandleInterval(value)) throw invalid(field, "is not a known candle interval")
  return value
}

function optionalId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  return text(value, "id")
}

/**
 * The check the editor runs, run again here.
 *
 * Types alone let through rules that are well formed and still unusable: a
 * fractional quantity, a close-based rule with no timeframe, an ATR rule with no
 * ATR. Those persist as armed and then never fire, or fail only at the moment
 * they try to exit. The editor is not the place to enforce it, because the
 * editor is not the only thing that can reach this route.
 *
 * The market price is deliberately not supplied: whether a level sits on the
 * far side of the market is a question about what the trader is looking at, and
 * the server would be answering it from a different tick.
 */
function checkDraft(problem: string | null): void {
  if (problem !== null) throw new ProtocolError("invalid_request", problem)
}

/**
 * A rule the trader wants armed.
 *
 * Drafts are checked rather than trusted: an unchecked one becomes a live rule
 * that can send an exit order, and the server creates the identifier and the
 * timestamps itself so its own clock decides when a rule was made.
 */
export function stopRuleDraft(body: Record<string, unknown>): StopRuleDraft {
  const draft: StopRuleDraft = {
    id: optionalId(body.id),
    instrumentUid: text(body.instrumentUid, "instrumentUid"),
    symbol: text(body.symbol, "symbol"),
    displayName: text(body.displayName, "displayName"),
    side: oneOf(body.side, STOP_POSITION_SIDES, "side"),
    role: oneOf(body.role, STOP_RULE_ROLES, "role"),
    kind: oneOf(body.kind, STOP_RULE_KINDS, "kind"),
    value: positiveNumber(body.value, "value"),
    basis: oneOf(body.basis, STOP_RULE_BASES, "basis"),
    interval: optionalInterval(body.interval, "interval"),
    quantity: optionalNumber(body.quantity, "quantity"),
    referencePrice: optionalNumber(body.referencePrice, "referencePrice"),
    atrValue: optionalNumber(body.atrValue, "atrValue"),
  }
  checkDraft(validateStopRule(draft, null))
  return draft
}

export function stopRuleStatus(value: unknown): StopRuleStatus {
  return oneOf(value, STOP_RULE_STATUSES, "status")
}

const STOP_DECISIONS = ["confirm", "cancel", "hold", "release"] as const

export function stopDecision(value: unknown): (typeof STOP_DECISIONS)[number] {
  return oneOf(value, STOP_DECISIONS, "decision")
}

export function priceAlertDraft(body: Record<string, unknown>): PriceAlertDraft {
  const draft: PriceAlertDraft = {
    id: optionalId(body.id),
    instrumentUid: text(body.instrumentUid, "instrumentUid"),
    symbol: text(body.symbol, "symbol"),
    displayName: text(body.displayName, "displayName"),
    direction: oneOf(body.direction, LEVEL_DIRECTIONS, "direction"),
    kind: oneOf(body.kind, ALERT_KINDS, "kind"),
    value: positiveNumber(body.value, "value"),
    basis: oneOf(body.basis, ALERT_BASES, "basis"),
    interval: optionalInterval(body.interval, "interval"),
    repeat: oneOf(body.repeat, ALERT_REPEATS, "repeat"),
    referencePrice: optionalNumber(body.referencePrice, "referencePrice"),
    atrValue: optionalNumber(body.atrValue, "atrValue"),
  }
  checkDraft(validatePriceAlert(draft, null))
  return draft
}

export function priceAlertStatus(value: unknown): PriceAlertStatus {
  return oneOf(value, ALERT_STATUSES, "status")
}

/**
 * Checked on the way in rather than only on the way out. The store falls back to
 * defaults when it reads something it does not recognise, so an unchecked write
 * would not fail — it would quietly reset the trader's settings on next launch.
 */
export function appPreferences(body: Record<string, unknown>): AppPreferences {
  const candleRange = oneOf(body.candleRange, CANDLE_RANGES, "candleRange")
  return normalizeAppPreferences({
    instrumentSort: oneOf(body.instrumentSort, INSTRUMENT_SORTS, "instrumentSort"),
    sortDirection: oneOf(body.sortDirection, SORT_DIRECTIONS, "sortDirection"),
    candleRange,
    candleInterval: oneOf(body.candleInterval, CANDLE_INTERVALS, "candleInterval"),
    chartTarget: oneOf(body.chartTarget, CANDLE_CHART_TARGETS, "chartTarget"),
    chartIndicators: indicatorList(body.chartIndicators),
    selectedInstrumentUid: body.selectedInstrumentUid === null || body.selectedInstrumentUid === undefined
      ? null
      : text(body.selectedInstrumentUid, "selectedInstrumentUid"),
    orderKind: oneOf(body.orderKind, VIOP_ORDER_KINDS, "orderKind"),
    selectedChatSessionId: body.selectedChatSessionId === null || body.selectedChatSessionId === undefined
      ? null
      : text(body.selectedChatSessionId, "selectedChatSessionId"),
    showChatThoughts: body.showChatThoughts === undefined
      ? true
      : boolean(body.showChatThoughts, "showChatThoughts"),
  })
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, "must be true or false")
  return value
}

function indicatorList(value: unknown): ChartIndicator[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw invalid("chartIndicators", "must be a list")
  // An indicator the app no longer draws is dropped rather than refused: a newer
  // client's extra overlay should not make its whole layout unsavable.
  return value.filter((name): name is ChartIndicator => typeof name === "string" && isChartIndicator(name))
}

/** The digest stays opaque; what the store indexes by is what gets checked. */
export function overviewSnapshot(body: Record<string, unknown>): StoredOverviewSnapshot {
  if (!body.digest || typeof body.digest !== "object") throw invalid("digest", "is required")
  return {
    instrumentUid: text(body.instrumentUid, "instrumentUid"),
    mode: overviewMode(body.mode),
    digest: body.digest as StoredOverviewSnapshot["digest"],
    commentary: typeof body.commentary === "string" ? body.commentary : "",
    generatedAt: positiveNumber(body.generatedAt, "generatedAt"),
  }
}

/**
 * A credential a login produced.
 *
 * Only the kind is checked. What is inside belongs to the model harness — its fields
 * differ per provider and grow with its versions — so re-describing it here would mean
 * refusing a credential this build simply has not heard about yet.
 */
export function aiCredential(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("credential", "is required")
  const kind = (value as { type?: unknown }).type
  if (kind !== "oauth" && kind !== "api_key") throw invalid("credential.type", 'must be "oauth" or "api_key"')
  return value as Record<string, unknown>
}

/** Which model answers. The ids stay free-form: they are the harness's vocabulary. */
export function aiModelChoice(body: Record<string, unknown>): AiModelChoice {
  return {
    providerId: text(body.providerId, "providerId"),
    modelId: text(body.modelId, "modelId"),
    reasoning: body.reasoning === null || body.reasoning === undefined ? null : text(body.reasoning, "reasoning"),
  }
}

/**
 * The chosen models, either of which may be unset.
 *
 * Null is a real value here — it is how a trader clears a choice — so it is accepted
 * rather than treated as a missing field.
 */
export function aiPreferences(body: Record<string, unknown>): AiPreferences {
  return {
    overview: choiceOrNull(body.overview, "overview"),
    chat: choiceOrNull(body.chat, "chat"),
  }
}

function choiceOrNull(value: unknown, field: string): AiModelChoice | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(field, "must be an object or null")
  return aiModelChoice(value as Record<string, unknown>)
}
