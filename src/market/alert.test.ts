import { expect, test } from "bun:test"
import {
  advanceAlertTrail,
  createPriceAlert,
  isAlertReached,
  resolveAlertLevel,
  validatePriceAlert,
  type PriceAlert,
  type PriceAlertDraft,
} from "./alert.ts"
import type { Candle } from "./candle.ts"

const NOW = 1_786_000_000_000

function draft(overrides: Partial<PriceAlertDraft> = {}): PriceAlertDraft {
  return {
    instrumentUid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    direction: "ABOVE",
    kind: "PRICE",
    value: 420,
    basis: "TOUCH",
    interval: null,
    repeat: "ONCE",
    referencePrice: 400,
    atrValue: null,
    ...overrides,
  }
}

function alert(overrides: Partial<PriceAlertDraft> = {}, patch: Partial<PriceAlert> = {}): PriceAlert {
  return { ...createPriceAlert(draft(overrides), NOW), ...patch }
}

function candle(close: number): Candle {
  return { timestamp: NOW, open: close, high: close + 1, low: close - 1, close, volume: null }
}

test("resolves a percent level on the side it watches", () => {
  expect(resolveAlertLevel(alert({ kind: "PERCENT", value: 5 }))).toBeCloseTo(420, 6)
  expect(resolveAlertLevel(alert({ kind: "PERCENT", value: 5, direction: "BELOW" }))).toBeCloseTo(380, 6)
})

test("measures an ATR level in multiples of the reading it was built with", () => {
  const above = alert({ kind: "ATR", value: 2, atrValue: 6, interval: "MIN_10" })
  expect(resolveAlertLevel(above)).toBeCloseTo(412, 6)

  // Without a reading there is no level to watch, rather than a level at zero
  // distance that fires immediately.
  expect(resolveAlertLevel(alert({ kind: "ATR", value: 2, atrValue: null, interval: "MIN_10" }))).toBeNull()
})

test("a trail follows the price away from the level and never loosens", () => {
  // Watching below: the level rides the high behind a rising market.
  const trailing = alert({ kind: "TRAILING_PERCENT", value: 2, direction: "BELOW" })
  expect(resolveAlertLevel(trailing)).toBeCloseTo(392, 6)

  const advanced = advanceAlertTrail(trailing, 420)
  expect(advanced).toEqual({ extremePrice: 420, triggerPrice: 411.6 })

  // A pullback does not move it back down.
  expect(advanceAlertTrail({ ...trailing, ...advanced }, 415)).toBeNull()
})

test("a trail watching above rides the low instead", () => {
  const trailing = alert({ kind: "TRAILING_PERCENT", value: 2, direction: "ABOVE" })
  const advanced = advanceAlertTrail(trailing, 380)

  // The market fell, so the level a bounce has to clear came down with it.
  expect(advanced?.extremePrice).toBe(380)
  expect(advanced?.triggerPrice).toBeCloseTo(387.6, 6)
  expect(advanceAlertTrail({ ...trailing, ...advanced }, 390)).toBeNull()
})

test("a touch reads the tick and a close reads the finished candle", () => {
  const touch = alert()
  expect(isAlertReached(touch, { lastPrice: 419 })).toBeFalse()
  expect(isAlertReached(touch, { lastPrice: 420 })).toBeTrue()
  // The tick is irrelevant to a close-based alert, and vice versa.
  expect(isAlertReached(touch, { closedCandle: candle(430) })).toBeFalse()

  const close = alert({ basis: "CLOSE", interval: "MIN_10" })
  expect(isAlertReached(close, { lastPrice: 430 })).toBeFalse()
  expect(isAlertReached(close, { closedCandle: candle(421) })).toBeTrue()
})

test("refuses a level the market has already passed", () => {
  // Saved as written, it would fire on the very next tick and say nothing.
  expect(validatePriceAlert(draft({ value: 390 }), 400)).toBe("A level above the market is required")
  expect(validatePriceAlert(draft({ direction: "BELOW", value: 410 }), 400)).toBe("A level below the market is required")
  expect(validatePriceAlert(draft(), 400)).toBeNull()
})

test("refuses a rule that cannot resolve the level it claims to watch", () => {
  expect(validatePriceAlert(draft({ value: 0 }), 400)).toBe("Value must be greater than zero")
  expect(validatePriceAlert(draft({ basis: "CLOSE", interval: null }), 400)).toBe("Close-based alerts need a timeframe")
  expect(validatePriceAlert(draft({ kind: "ATR", value: 2, interval: "MIN_10", atrValue: null }), 400))
    .toBe("ATR is unavailable for this timeframe")
  expect(validatePriceAlert(draft({ kind: "PERCENT", value: 5, referencePrice: null }), 400))
    .toBe("No market price to measure from")
})

test("a new alert starts armed, with a trail seeded from the market", () => {
  const fresh = createPriceAlert(draft({ kind: "TRAILING_PERCENT", value: 2, direction: "BELOW" }), NOW)

  expect(fresh.status).toBe("ARMED")
  expect(fresh.extremePrice).toBe(400)
  expect(fresh.triggeredAt).toBeNull()
  expect(fresh.triggeredPrice).toBeNull()

  // A standing level has no extreme to follow.
  expect(createPriceAlert(draft(), NOW).extremePrice).toBeNull()
})
