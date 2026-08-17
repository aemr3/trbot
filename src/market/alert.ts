// Price levels the trader wants to hear about. An alert is the same shape of
// rule as a protective stop — a level, how it is measured, and what counts as
// reaching it — but it is not attached to a position and it never trades. When
// one fires the app says so, out loud, and that is the whole of it.
import type { Candle, CandleInterval } from "./candle.ts"
import {
  isLevelReached,
  offsetLevel as offsetByDistance,
  tightensLevel,
  type LevelDirection,
} from "./price-level.ts"

// How the level is derived. PRICE is typed outright; PERCENT and ATR are
// measured once from the market at the time of writing and then stand still;
// the trailing kinds follow the extreme the price has reached since.
export const ALERT_KINDS = ["PRICE", "PERCENT", "ATR", "TRAILING_PERCENT", "TRAILING_ATR"] as const
export type PriceAlertKind = (typeof ALERT_KINDS)[number]

// What counts as reaching the level: any trade through it, or only a candle
// that finishes beyond it.
export const ALERT_BASES = ["TOUCH", "CLOSE"] as const
export type PriceAlertBasis = (typeof ALERT_BASES)[number]

// ARMED watches the price. PAUSED is the trader's own hold. TRIGGERED has
// already fired and stays that way until it is re-armed, so one crossing is
// announced once rather than on every tick beyond the level.
export const ALERT_STATUSES = ["ARMED", "PAUSED", "TRIGGERED"] as const
export type PriceAlertStatus = (typeof ALERT_STATUSES)[number]

// What happens after it fires. ONCE is spent and waits to be re-armed by hand.
// ALWAYS stays armed and announces the next crossing too — but only after the
// price has come back to the near side, so a market sitting beyond the level
// does not ring on every tick.
export const ALERT_REPEATS = ["ONCE", "ALWAYS"] as const
export type PriceAlertRepeat = (typeof ALERT_REPEATS)[number]

export interface PriceAlert {
  id: string
  instrumentUid: string
  symbol: string
  displayName: string
  // The side the market has to come from to reach the level.
  direction: LevelDirection
  kind: PriceAlertKind
  // Price, percent, or ATR multiple, depending on `kind`.
  value: number
  basis: PriceAlertBasis
  // Required by CLOSE (which candles to read) and by the ATR kinds.
  interval: CandleInterval | null
  repeat: PriceAlertRepeat
  status: PriceAlertStatus
  // The working level. Fixed for PRICE/PERCENT/ATR, rewritten as a trail advances.
  triggerPrice: number | null
  // Furthest the price has run away from the level since arming, for the
  // trailing kinds: an alert watching below follows the high, and one watching
  // above follows the low.
  extremePrice: number | null
  // Market price the offset kinds were measured from.
  referencePrice: number | null
  // ATR reading the level was built from, kept so a row can explain itself.
  atrValue: number | null
  createdAt: number
  updatedAt: number
  triggeredAt: number | null
  // The price that reached the level, so a fired alert still says what it saw.
  triggeredPrice: number | null
}

// What the editor collects; everything else is derived by `createPriceAlert`.
export interface PriceAlertDraft {
  id?: string
  instrumentUid: string
  symbol: string
  displayName: string
  direction: LevelDirection
  kind: PriceAlertKind
  value: number
  basis: PriceAlertBasis
  interval: CandleInterval | null
  repeat: PriceAlertRepeat
  referencePrice: number | null
  atrValue: number | null
}

// Persistence contract; the implementation lives in src/db and stays out of the
// domain so the storage engine can change without touching alert logic.
export interface PriceAlertStore {
  list(): Promise<PriceAlert[]>
  put(alert: PriceAlert): Promise<void>
  remove(id: string): Promise<void>
}

export function isPriceAlertKind(value: string): value is PriceAlertKind {
  return ALERT_KINDS.some((kind) => kind === value)
}

export function isPriceAlertBasis(value: string): value is PriceAlertBasis {
  return ALERT_BASES.some((basis) => basis === value)
}

export function isPriceAlertStatus(value: string): value is PriceAlertStatus {
  return ALERT_STATUSES.some((status) => status === value)
}

export function isPriceAlertRepeat(value: string): value is PriceAlertRepeat {
  return ALERT_REPEATS.some((repeat) => repeat === value)
}

/** True for the kinds whose level follows the extreme the price has reached. */
export function isTrailingAlert(kind: PriceAlertKind): boolean {
  return kind === "TRAILING_PERCENT" || kind === "TRAILING_ATR"
}

/** True for the kinds measured in ATR multiples, which need candles. */
export function isAtrAlert(kind: PriceAlertKind): boolean {
  return kind === "ATR" || kind === "TRAILING_ATR"
}

/** An alert needs candles when it reads closes or measures in ATR. */
export function alertNeedsCandles(alert: PriceAlert): boolean {
  return alert.basis === "CLOSE" || isAtrAlert(alert.kind)
}

/** The level an alert currently watches, or null while it cannot be resolved. */
export function resolveAlertLevel(alert: PriceAlert): number | null {
  if (isTrailingAlert(alert.kind)) {
    return trailFrom(alert, alert.extremePrice) ?? positiveFinite(alert.triggerPrice)
  }
  return positiveFinite(alert.triggerPrice)
}

/**
 * Follows the price away from the level: an alert watching below rides the
 * high, one watching above rides the low. Returns null when the extreme has not
 * improved, so an unchanged alert is never rewritten or re-persisted.
 */
export function advanceAlertTrail(
  alert: PriceAlert,
  price: number,
): Pick<PriceAlert, "extremePrice" | "triggerPrice"> | null {
  if (!isTrailingAlert(alert.kind) || !Number.isFinite(price) || price <= 0) return null
  const improved = alert.extremePrice === null
    || (alert.direction === "BELOW" ? price > alert.extremePrice : price < alert.extremePrice)
  if (!improved) return null
  const level = trailFrom(alert, price)
  if (level === null) return null
  const tightened = tightensLevel(alert.direction, alert.triggerPrice, level)
  return { extremePrice: price, triggerPrice: tightened ? level : alert.triggerPrice }
}

export interface PriceAlertSample {
  lastPrice?: number | null
  // The most recent candle that has finished; a forming candle never triggers.
  closedCandle?: Candle | null
}

/** Whether the sample has reached the alert's level. */
export function isAlertReached(alert: PriceAlert, sample: PriceAlertSample): boolean {
  const level = resolveAlertLevel(alert)
  if (level === null) return false
  const price = alert.basis === "CLOSE" ? (sample.closedCandle?.close ?? null) : (sample.lastPrice ?? null)
  if (price === null) return false
  return isLevelReached(alert.direction, price, level)
}

/**
 * Builds an alert from the editor's draft, resolving the offset kinds into a
 * standing level so an alert always knows the price it is watching.
 */
export function createPriceAlert(draft: PriceAlertDraft, now: number): PriceAlert {
  return {
    id: draft.id ?? crypto.randomUUID(),
    instrumentUid: draft.instrumentUid,
    symbol: draft.symbol,
    displayName: draft.displayName,
    direction: draft.direction,
    kind: draft.kind,
    value: draft.value,
    basis: draft.basis,
    interval: draft.interval,
    repeat: draft.repeat,
    status: "ARMED",
    triggerPrice: draftLevel(draft),
    extremePrice: isTrailingAlert(draft.kind) ? draft.referencePrice : null,
    referencePrice: draft.referencePrice,
    atrValue: draft.atrValue,
    createdAt: now,
    updatedAt: now,
    triggeredAt: null,
    triggeredPrice: null,
  }
}

/** Editor validation; returns the first problem, or null when the draft is sound. */
export function validatePriceAlert(draft: PriceAlertDraft, lastPrice: number | null): string | null {
  if (!Number.isFinite(draft.value) || draft.value <= 0) return "Value must be greater than zero"
  if (draft.basis === "CLOSE" && draft.interval === null) return "Close-based alerts need a timeframe"
  if (isAtrAlert(draft.kind) && draft.interval === null) return "ATR alerts need a timeframe"
  if (isAtrAlert(draft.kind) && (draft.atrValue === null || draft.atrValue <= 0)) {
    return "ATR is unavailable for this timeframe"
  }
  if (draft.kind !== "PRICE" && (draft.referencePrice === null || draft.referencePrice <= 0)) {
    return "No market price to measure from"
  }
  const level = draftLevel(draft)
  if (level === null || level <= 0) return "The level could not be resolved"
  // A level the market has already passed would fire the moment it is saved,
  // which is never what the trader meant to type.
  if (lastPrice !== null && Number.isFinite(lastPrice)) {
    if (draft.direction === "BELOW" && level >= lastPrice) return "A level below the market is required"
    if (draft.direction === "ABOVE" && level <= lastPrice) return "A level above the market is required"
  }
  return null
}

/** The level a draft resolves to, before it becomes an alert. */
function draftLevel(draft: PriceAlertDraft): number | null {
  if (draft.kind === "PRICE") return positiveFinite(draft.value)
  const anchor = positiveFinite(draft.referencePrice)
  if (anchor === null) return null
  return offsetLevel(draft, anchor)
}

/** Applies a trailing alert's width to the given anchor price. */
function trailFrom(alert: PriceAlert, anchor: number | null): number | null {
  const base = positiveFinite(anchor)
  return base === null ? null : offsetLevel(alert, base)
}

/** Moves `anchor` by the alert's width, in the direction it watches. */
function offsetLevel(
  alert: Pick<PriceAlert, "direction" | "kind" | "value" | "atrValue">,
  anchor: number,
): number | null {
  const distance = isAtrAlert(alert.kind)
    ? multiplyFinite(alert.atrValue, alert.value)
    : multiplyFinite(anchor, alert.value / 100)
  if (distance === null) return null
  return offsetByDistance(alert.direction, anchor, distance)
}

function multiplyFinite(left: number | null, right: number): number | null {
  if (left === null || !Number.isFinite(left) || !Number.isFinite(right)) return null
  return left * right
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}
