import { expect, test } from "bun:test"
import type { Candle } from "@trbot/market/candle.ts"
import type { AccountPosition } from "./account.ts"
import {
  advanceTrailingStop,
  createStopRule,
  isStopBreached,
  reconcileStopRule,
  resolveStopLevel,
  stopExitSide,
  stopRuleDirection,
  stopRuleQuantity,
  validateStopRule,
  type StopRule,
  type StopRuleDraft,
} from "./stop.ts"

const NOW = 1_786_000_000_000

function draft(overrides: Partial<StopRuleDraft> = {}): StopRuleDraft {
  return {
    instrumentUid: "instrument-1",
    symbol: "ASELS",
    displayName: "ASELS",
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 380,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 400,
    atrValue: null,
    ...overrides,
  }
}

function rule(overrides: Partial<StopRuleDraft> = {}): StopRule {
  return createStopRule(draft(overrides), NOW)
}

function candle(close: number): Candle {
  return { timestamp: NOW, open: close, high: close, low: close, close, volume: null }
}

function position(quantity: number): AccountPosition {
  return {
    uid: "instrument-1",
    symbol: "ASELS",
    displayName: "ASELS",
    quantity,
    averageCost: 400,
    currentPrice: 395,
    unrealizedProfitLoss: null,
    currency: "TRY",
  }
}

test("a stop sits under a long and over a short, a target the other way", () => {
  expect(stopRuleDirection({ role: "STOP", side: "LONG" })).toBe("BELOW")
  expect(stopRuleDirection({ role: "TARGET", side: "LONG" })).toBe("ABOVE")
  expect(stopRuleDirection({ role: "STOP", side: "SHORT" })).toBe("ABOVE")
  expect(stopRuleDirection({ role: "TARGET", side: "SHORT" })).toBe("BELOW")
  expect(stopExitSide("LONG")).toBe("SELL")
  expect(stopExitSide("SHORT")).toBe("BUY")
})

test("resolves a level for every rule kind", () => {
  expect(resolveStopLevel(rule({ kind: "PRICE", value: 380 }))).toBe(380)
  // 2% under a 400 entry.
  expect(resolveStopLevel(rule({ kind: "PERCENT", value: 2 }))).toBeCloseTo(392, 6)
  // 1.5 x an ATR of 4, under the entry.
  expect(resolveStopLevel(rule({ kind: "ATR", value: 1.5, interval: "MIN_15", atrValue: 4 }))).toBeCloseTo(394, 6)
  // A short's stop is measured upward.
  expect(resolveStopLevel(rule({ side: "SHORT", kind: "PERCENT", value: 2 }))).toBeCloseTo(408, 6)
  // A target is measured toward profit.
  expect(resolveStopLevel(rule({ role: "TARGET", kind: "PERCENT", value: 5 }))).toBeCloseTo(420, 6)
})

test("a trailing stop follows the best price and never loosens", () => {
  const trailing = rule({ kind: "TRAILING_PERCENT", value: 2 })
  expect(resolveStopLevel(trailing)).toBeCloseTo(392, 6) // 2% under the 400 entry

  const advanced = advanceTrailingStop(trailing, 420)
  expect(advanced).toEqual({ extremePrice: 420, triggerPrice: 411.6 })

  const moved = { ...trailing, ...advanced! }
  // A pullback moves nothing.
  expect(advanceTrailingStop(moved, 410)).toBeNull()
  expect(resolveStopLevel(moved)).toBeCloseTo(411.6, 6)

  // A short trails downward.
  const short = rule({ side: "SHORT", kind: "TRAILING_PERCENT", value: 2 })
  expect(advanceTrailingStop(short, 380)).toEqual({ extremePrice: 380, triggerPrice: 387.6 })
})

test("a widening ATR cannot loosen a trail that already moved", () => {
  const trailing = rule({ kind: "TRAILING_ATR", value: 2, interval: "MIN_15", atrValue: 3 })
  const advanced = advanceTrailingStop(trailing, 420)!
  expect(advanced.triggerPrice).toBeCloseTo(414, 6)

  // The same high-water mark with a much wider ATR keeps the tighter level.
  const wider = { ...trailing, ...advanced, atrValue: 20 }
  const again = advanceTrailingStop(wider, 421)
  expect(again?.triggerPrice).toBeCloseTo(414, 6)
})

test("touch reads the last price, close reads only a finished candle", () => {
  const touch = rule({ kind: "PRICE", value: 380 })
  expect(isStopBreached(touch, { lastPrice: 381 })).toBe(false)
  expect(isStopBreached(touch, { lastPrice: 380 })).toBe(true)
  expect(isStopBreached(touch, { lastPrice: 379 })).toBe(true)

  const onClose = rule({ kind: "PRICE", value: 380, basis: "CLOSE", interval: "MIN_15" })
  // A wick through the level is not a close through it.
  expect(isStopBreached(onClose, { lastPrice: 370, closedCandle: candle(381) })).toBe(false)
  expect(isStopBreached(onClose, { lastPrice: 400, closedCandle: candle(379) })).toBe(true)
  expect(isStopBreached(onClose, { lastPrice: 370, closedCandle: null })).toBe(false)

  // A short's stop is breached upward.
  const short = rule({ side: "SHORT", kind: "PRICE", value: 420 })
  expect(isStopBreached(short, { lastPrice: 419 })).toBe(false)
  expect(isStopBreached(short, { lastPrice: 421 })).toBe(true)
})

test("rejects a draft that would fire the moment it is saved", () => {
  // A long's stop must sit under the market.
  expect(validateStopRule(draft({ value: 380 }), 400)).toBeNull()
  expect(validateStopRule(draft({ value: 410 }), 400)).toBe("A level below the market is required")
  expect(validateStopRule(draft({ role: "TARGET", value: 420 }), 400)).toBeNull()
  expect(validateStopRule(draft({ role: "TARGET", value: 390 }), 400)).toBe("A level above the market is required")
})

test("rejects drafts missing what their kind needs", () => {
  expect(validateStopRule(draft({ value: 0 }), 400)).toBe("Value must be greater than zero")
  expect(validateStopRule(draft({ quantity: 1.5 }), 400)).toBe("Quantity must be a whole number of contracts")
  expect(validateStopRule(draft({ basis: "CLOSE" }), 400)).toBe("Close-based rules need a timeframe")
  expect(validateStopRule(draft({ kind: "ATR", value: 2 }), 400)).toBe("ATR rules need a timeframe")
  expect(validateStopRule(draft({ kind: "ATR", value: 2, interval: "MIN_15" }), 400))
    .toBe("ATR is unavailable for this timeframe")
  expect(validateStopRule(draft({ kind: "PERCENT", value: 2, referencePrice: null }), 400))
    .toBe("The position has no average cost to measure from")
})

test("reconciles a rule against the position it protects", () => {
  const armed = rule()
  expect(reconcileStopRule(armed, position(2), NOW)).toBe(armed)
  expect(reconcileStopRule(armed, undefined, NOW).status).toBe("DONE")
  expect(reconcileStopRule(armed, position(0), NOW).status).toBe("DONE")
  // The position flipped short: exiting it as a long would open a new one.
  expect(reconcileStopRule(armed, position(-2), NOW).status).toBe("PAUSED")
  // A triggered rule keeps its state until the trader resolves it.
  const triggered: StopRule = { ...armed, status: "TRIGGERED" }
  expect(reconcileStopRule(triggered, position(-2), NOW).status).toBe("TRIGGERED")
})

test("exits what the position still holds", () => {
  expect(stopRuleQuantity(rule({ quantity: null }), position(3))).toBe(3)
  expect(stopRuleQuantity(rule({ quantity: 2 }), position(3))).toBe(2)
  // A partially closed position caps the exit.
  expect(stopRuleQuantity(rule({ quantity: 5 }), position(3))).toBe(3)
  expect(stopRuleQuantity(rule({ quantity: 5 }), position(-3))).toBe(3)
})
