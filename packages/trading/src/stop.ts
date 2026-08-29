// Protective levels for open VIOP positions: where a position should be closed
// to cap a loss or take a profit. A rule is plain data — the monitor decides
// when one is breached, and the trader confirms every exit it proposes.
import { CANDLE_INTERVALS, type Candle, type CandleInterval } from "@trbot/market/candle.ts"
import { isLevelReached, offsetLevel as offsetByDistance, tightensLevel, type LevelDirection } from "@trbot/market/price-level.ts"
import type { AccountPosition } from "./account.ts"
import type { ViopOrderSide } from "./order.ts"
import { z } from "zod"

// Which side of the position the level protects: a stop caps the loss, a target
// takes the profit. A position may carry one of each.
export const STOP_RULE_ROLES = ["STOP", "TARGET"] as const
export type StopRuleRole = (typeof STOP_RULE_ROLES)[number]

// How the level is derived. PRICE is typed outright; PERCENT and ATR are
// measured from the entry once and then stand still; the trailing kinds follow
// the best price the position has seen.
export const STOP_RULE_KINDS = ["PRICE", "PERCENT", "ATR", "TRAILING_PERCENT", "TRAILING_ATR"] as const
export type StopRuleKind = (typeof STOP_RULE_KINDS)[number]

// What counts as reaching the level: any trade through it, or only a candle
// that finishes beyond it. CLOSE ignores the wicks that shake out touch stops.
export const STOP_RULE_BASES = ["TOUCH", "CLOSE"] as const
export type StopRuleBasis = (typeof STOP_RULE_BASES)[number]

export const STOP_POSITION_SIDES = ["LONG", "SHORT"] as const
export type StopPositionSide = (typeof STOP_POSITION_SIDES)[number]

// ARMED watches the price. PAUSED is the trader's own hold. TRIGGERED means the
// level was reached and an exit was proposed — it never re-arms itself, so an
// interrupted trigger stays visible instead of firing twice. DONE is a rule
// whose position is gone.
export const STOP_RULE_STATUSES = ["ARMED", "PAUSED", "TRIGGERED", "DONE"] as const
export type StopRuleStatus = (typeof STOP_RULE_STATUSES)[number]

export interface StopRule {
  id: string
  instrumentUid: string
  symbol: string
  displayName: string
  // Captured when the rule is written, so a rule still reads correctly after
  // its position is gone, and so a flipped position can be detected.
  side: StopPositionSide
  role: StopRuleRole
  kind: StopRuleKind
  // Price, percent, or ATR multiple, depending on `kind`.
  value: number
  basis: StopRuleBasis
  // Required by CLOSE (which candles to read) and by the ATR kinds.
  interval: CandleInterval | null
  // Contracts to exit; null exits whatever the position holds at the time.
  quantity: number | null
  status: StopRuleStatus
  // The working level. Fixed for PRICE/PERCENT/ATR, rewritten as a trail advances.
  triggerPrice: number | null
  // Best price seen since arming, for the trailing kinds.
  extremePrice: number | null
  // Average cost the offset kinds were measured from.
  referencePrice: number | null
  // ATR reading the level was built from, kept so a row can explain itself.
  atrValue: number | null
  createdAt: number
  updatedAt: number
  triggeredAt: number | null
  // Exit order the trigger produced, so an interrupted run can be reconciled
  // against the orders tab.
  exitOrderUid: string | null
}

// What the editor collects; everything else is derived by `createStopRule`.
export interface StopRuleDraft {
  id?: string
  instrumentUid: string
  symbol: string
  displayName: string
  side: StopPositionSide
  role: StopRuleRole
  kind: StopRuleKind
  value: number
  basis: StopRuleBasis
  interval: CandleInterval | null
  quantity: number | null
  referencePrice: number | null
  atrValue: number | null
}

const RequiredTextSchema = z.string().refine((value) => value.trim().length > 0)

/** Structural boundary for drafts; position and market semantics remain in validateStopRule. */
export const StopRuleDraftSchema: z.ZodType<StopRuleDraft> = z.object({
  id: RequiredTextSchema.optional(),
  instrumentUid: RequiredTextSchema,
  symbol: RequiredTextSchema,
  displayName: RequiredTextSchema,
  side: z.enum(STOP_POSITION_SIDES),
  role: z.enum(STOP_RULE_ROLES),
  kind: z.enum(STOP_RULE_KINDS),
  value: z.number().positive(),
  basis: z.enum(STOP_RULE_BASES),
  interval: z.enum(CANDLE_INTERVALS).nullable(),
  quantity: z.number().nullable(),
  referencePrice: z.number().nullable(),
  atrValue: z.number().nullable(),
})

export const StopRuleSchema: z.ZodType<StopRule> = z.object({
  id: RequiredTextSchema,
  instrumentUid: RequiredTextSchema,
  symbol: RequiredTextSchema,
  displayName: RequiredTextSchema,
  side: z.enum(STOP_POSITION_SIDES),
  role: z.enum(STOP_RULE_ROLES),
  kind: z.enum(STOP_RULE_KINDS),
  value: z.number().positive(),
  basis: z.enum(STOP_RULE_BASES),
  interval: z.enum(CANDLE_INTERVALS).nullable(),
  quantity: z.number().nullable(),
  status: z.enum(STOP_RULE_STATUSES),
  triggerPrice: z.number().nullable(),
  extremePrice: z.number().nullable(),
  referencePrice: z.number().nullable(),
  atrValue: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  triggeredAt: z.number().nullable(),
  exitOrderUid: z.string().nullable(),
})

export const STOP_DECISIONS = ["confirm", "cancel", "hold", "release"] as const
export type StopDecision = (typeof STOP_DECISIONS)[number]

export const StopRuleStatusRequestSchema = z.object({ status: z.enum(STOP_RULE_STATUSES) })
export const StopDecisionRequestSchema = z.object({ decision: z.enum(STOP_DECISIONS) })

// Persistence contract; the implementation lives in @trbot/db and stays out of
// the domain so the storage engine can change without touching stop logic.
export interface StopRuleStore {
  list(): Promise<StopRule[]>
  put(rule: StopRule): Promise<void>
  remove(id: string): Promise<void>
}

/** Whether a protective rule can still affect or describe an open position. */
export function isOpenStopRule(rule: Pick<StopRule, "status">): boolean {
  return rule.status !== "DONE"
}

/** True for the kinds whose level follows the best price seen. */
export function isTrailingStopRule(kind: StopRuleKind): boolean {
  return kind === "TRAILING_PERCENT" || kind === "TRAILING_ATR"
}

/** True for the kinds measured in ATR multiples, which need candles. */
export function isAtrStopRule(kind: StopRuleKind): boolean {
  return kind === "ATR" || kind === "TRAILING_ATR"
}

/** A rule needs candles when it reads closes or measures in ATR. */
export function stopRuleNeedsCandles(rule: StopRule): boolean {
  return rule.basis === "CLOSE" || isAtrStopRule(rule.kind)
}

export function stopPositionSide(quantity: number): StopPositionSide {
  return quantity >= 0 ? "LONG" : "SHORT"
}

/** The order that closes the position a rule protects. */
export function stopExitSide(side: StopPositionSide): ViopOrderSide {
  return side === "LONG" ? "SELL" : "BUY"
}

/**
 * Which way price has to move to reach the level. A long is stopped below and
 * targeted above; a short is the mirror image. Everything downstream compares
 * against this instead of re-deriving long/short.
 */
export function stopRuleDirection(rule: Pick<StopRule, "role" | "side">): LevelDirection {
  const below = rule.side === "LONG" ? rule.role === "STOP" : rule.role === "TARGET"
  return below ? "BELOW" : "ABOVE"
}

/** The level a rule currently watches, or null while it cannot be resolved. */
export function resolveStopLevel(rule: StopRule): number | null {
  if (isTrailingStopRule(rule.kind)) {
    const trail = trailFrom(rule, rule.extremePrice)
    return trail?.triggerPrice ?? positiveFinite(rule.triggerPrice)
  }
  return positiveFinite(rule.triggerPrice)
}

/**
 * Moves a trailing level up behind a rising long (or down behind a falling
 * short). Returns null when the best price has not improved, so an unchanged
 * rule is never rewritten or re-persisted. A trail only ever tightens.
 */
export function advanceTrailingStop(
  rule: StopRule,
  price: number,
): Pick<StopRule, "extremePrice" | "triggerPrice"> | null {
  if (!isTrailingStopRule(rule.kind) || !Number.isFinite(price) || price <= 0) return null
  const improved = rule.extremePrice === null
    || (rule.side === "LONG" ? price > rule.extremePrice : price < rule.extremePrice)
  if (!improved) return null
  const trail = trailFrom(rule, price)
  if (!trail) return null
  const tightened = tightensLevel(stopRuleDirection(rule), rule.triggerPrice, trail.triggerPrice)
  return { extremePrice: price, triggerPrice: tightened ? trail.triggerPrice : rule.triggerPrice }
}

export interface StopRuleSample {
  lastPrice?: number | null
  // The most recent candle that has finished; a forming candle never triggers.
  closedCandle?: Candle | null
}

/** Whether the sample has reached the rule's level. */
export function isStopBreached(rule: StopRule, sample: StopRuleSample): boolean {
  const level = resolveStopLevel(rule)
  if (level === null) return false
  const price = rule.basis === "CLOSE" ? (sample.closedCandle?.close ?? null) : (sample.lastPrice ?? null)
  if (price === null) return false
  return isLevelReached(stopRuleDirection(rule), price, level)
}

/** Contracts the exit should cover, clamped to what the position still holds. */
export function stopRuleQuantity(rule: StopRule, position: AccountPosition): number {
  const open = Math.abs(position.quantity)
  if (rule.quantity === null) return open
  return Math.max(0, Math.min(rule.quantity, open))
}

/**
 * Builds a rule from the editor's draft, resolving the offset kinds into a
 * standing level so a rule always knows the price it is watching.
 */
export function createStopRule(draft: StopRuleDraft, now: number): StopRule {
  const triggerPrice = resolveStopRuleDraftLevel(draft)
  return {
    id: draft.id ?? crypto.randomUUID(),
    instrumentUid: draft.instrumentUid,
    symbol: draft.symbol,
    displayName: draft.displayName,
    side: draft.side,
    role: draft.role,
    kind: draft.kind,
    value: draft.value,
    basis: draft.basis,
    interval: draft.interval,
    quantity: draft.quantity,
    status: "ARMED",
    triggerPrice,
    extremePrice: isTrailingStopRule(draft.kind) ? draft.referencePrice : null,
    referencePrice: draft.referencePrice,
    atrValue: draft.atrValue,
    createdAt: now,
    updatedAt: now,
    triggeredAt: null,
    exitOrderUid: null,
  }
}

/** Editor validation; returns the first problem, or null when the draft is sound. */
export function validateStopRule(draft: StopRuleDraft, lastPrice: number | null): string | null {
  if (!Number.isFinite(draft.value) || draft.value <= 0) return "Value must be greater than zero"
  if (draft.quantity !== null && (!Number.isInteger(draft.quantity) || draft.quantity <= 0)) {
    return "Quantity must be a whole number of contracts"
  }
  if (draft.basis === "CLOSE" && draft.interval === null) return "Close-based rules need a timeframe"
  if (isAtrStopRule(draft.kind) && draft.interval === null) return "ATR rules need a timeframe"
  if (isAtrStopRule(draft.kind) && (draft.atrValue === null || draft.atrValue <= 0)) {
    return "ATR is unavailable for this timeframe"
  }
  if (draft.kind !== "PRICE" && (draft.referencePrice === null || draft.referencePrice <= 0)) {
    return "The position has no average cost to measure from"
  }
  const level = resolveStopRuleDraftLevel(draft)
  if (level === null || level <= 0) return "The level could not be resolved"
  // A level already on the far side of the market would fire the moment it is
  // saved, which is never what the trader meant to type.
  if (lastPrice !== null && Number.isFinite(lastPrice)) {
    const below = stopRuleDirection(draft) === "BELOW"
    if (below && level >= lastPrice) return "A level below the market is required"
    if (!below && level <= lastPrice) return "A level above the market is required"
  }
  return null
}

/**
 * Keeps a rule honest about the position it protects: a closed position ends
 * the rule, and a position that flipped side puts it on hold rather than
 * letting it exit the wrong way. Returns the same rule when nothing changed.
 */
export function reconcileStopRule(rule: StopRule, position: AccountPosition | undefined, now: number): StopRule {
  if (rule.status === "DONE") return rule
  if (!position || position.quantity === 0) {
    return { ...rule, status: "DONE", updatedAt: now }
  }
  if (stopPositionSide(position.quantity) !== rule.side && rule.status !== "TRIGGERED") {
    return { ...rule, status: "PAUSED", updatedAt: now }
  }
  return rule
}

/** The level a draft resolves to, before it becomes a rule. */
export function resolveStopRuleDraftLevel(draft: StopRuleDraft): number | null {
  if (draft.kind === "PRICE") return positiveFinite(draft.value)
  const anchor = positiveFinite(draft.referencePrice)
  if (anchor === null) return null
  return offsetLevel(draft, anchor)
}

/** Applies a trailing rule's width to the given anchor price. */
function trailFrom(rule: StopRule, anchor: number | null): { triggerPrice: number } | null {
  const base = positiveFinite(anchor)
  if (base === null) return null
  const level = offsetLevel(rule, base)
  return level === null ? null : { triggerPrice: level }
}

/** Moves `anchor` by the rule's width, in the direction the rule watches. */
function offsetLevel(
  rule: Pick<StopRule, "role" | "side" | "kind" | "value" | "atrValue">,
  anchor: number,
): number | null {
  const distance = isAtrStopRule(rule.kind)
    ? multiplyFinite(rule.atrValue, rule.value)
    : multiplyFinite(anchor, rule.value / 100)
  if (distance === null) return null
  return offsetByDistance(stopRuleDirection(rule), anchor, distance)
}

function multiplyFinite(left: number | null, right: number): number | null {
  if (left === null || !Number.isFinite(left) || !Number.isFinite(right)) return null
  return left * right
}

function positiveFinite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null
}
