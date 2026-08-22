import { expect, test } from "bun:test"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "@trbot/market/candle.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { AccountPosition } from "./account.ts"
import { StopMonitor, rangeForInterval, type StopTriggerEvent } from "./stop-monitor.ts"
import { createStopRule, type StopRule, type StopRuleDraft, type StopRuleStore } from "./stop.ts"

const NOW = 1_786_000_000_000
const INTERVAL_MS = 900_000 // 15 minutes

class FakeStopRuleStore implements StopRuleStore {
  readonly rules = new Map<string, StopRule>()
  puts = 0

  constructor(seed: StopRule[] = []) {
    for (const rule of seed) this.rules.set(rule.id, rule)
  }

  async list(): Promise<StopRule[]> {
    return [...this.rules.values()]
  }

  async put(rule: StopRule): Promise<void> {
    this.puts += 1
    this.rules.set(rule.id, rule)
  }

  async remove(id: string): Promise<void> {
    this.rules.delete(id)
  }
}

class FakeCandleSource implements CandleSource {
  requests: Array<{ instrumentUid: string; interval: CandleInterval; range: CandleRange }> = []
  candles: Candle[] = []

  async loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
  ): Promise<CandleSeries> {
    this.requests.push({ instrumentUid, interval, range })
    return {
      instrumentUid,
      range,
      interval,
      candles: this.candles,
      availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
      intervalMs: INTERVAL_MS,
      currency: "TRY",
    }
  }
}

function rule(overrides: Partial<StopRuleDraft> = {}, patch: Partial<StopRule> = {}): StopRule {
  const draft: StopRuleDraft = {
    id: "rule-1",
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
  return { ...createStopRule(draft, NOW), ...patch }
}

function position(quantity = 2): AccountPosition {
  return {
    uid: "instrument-1",
    symbol: "ASELS",
    displayName: "ASELS",
    quantity,
    averageCost: 400,
    currentPrice: 400,
    unrealizedProfitLoss: null,
    currency: "TRY",
  }
}

function quote(price: number, timestamp = NOW): QuoteUpdate {
  return { symbol: "ASELS", lastPrice: price, sessionStatus: null, timestamp }
}

async function monitorWith(
  rules: StopRule[],
  overrides: { candles?: CandleSource; stalePriceMs?: number; now?: () => number } = {},
) {
  const store = new FakeStopRuleStore(rules)
  const triggers: StopTriggerEvent[] = []
  const monitor = new StopMonitor({
    store,
    onTrigger: (event) => triggers.push(event),
    now: () => NOW,
    ...overrides,
  })
  await monitor.load()
  monitor.setPositions([position()])
  return { monitor, store, triggers }
}

test("fires a touch stop once, after the market has been seen on the safe side", async () => {
  const { monitor, store, triggers } = await monitorWith([rule()])

  // The very first tick only establishes that the level is not already passed.
  monitor.applyQuote(quote(379))
  expect(triggers).toHaveLength(0)

  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(379))
  expect(triggers).toHaveLength(1)
  expect(triggers[0]).toMatchObject({ price: 379, quantity: 2, side: "SELL" })
  expect(store.rules.get("rule-1")?.status).toBe("TRIGGERED")

  // A triggered rule is spent: more ticks through the level change nothing.
  monitor.applyQuote(quote(370))
  expect(triggers).toHaveLength(1)
})

test("ignores a tick too old to trade on", async () => {
  const { monitor, triggers } = await monitorWith([rule()], { stalePriceMs: 10_000 })

  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(379, NOW - 60_000))
  expect(triggers).toHaveLength(0)

  const views = monitor.views()
  expect(views[0]?.feed).toBe("stale")
  expect(views[0]?.level).toBe(380)
})

test("will not fire without a position to close", async () => {
  const store = new FakeStopRuleStore([rule()])
  const triggers: StopTriggerEvent[] = []
  const monitor = new StopMonitor({ store, onTrigger: (event) => triggers.push(event), now: () => NOW })
  await monitor.load()

  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(379))
  expect(triggers).toHaveLength(0)

  // The position closing ends the rule; a flip puts it on hold.
  monitor.setPositions([position()])
  monitor.setPositions([])
  expect(store.rules.get("rule-1")?.status).toBe("DONE")
})

test("stands a rule down when its position flips side", async () => {
  const { monitor, store } = await monitorWith([rule()])

  monitor.setPositions([position(-2)])
  expect(store.rules.get("rule-1")?.status).toBe("PAUSED")
})

test("persists a trailing level as it advances, and never loosens it", async () => {
  const { monitor, store, triggers } = await monitorWith([rule({ kind: "TRAILING_PERCENT", value: 2 })])

  monitor.applyQuote(quote(400))
  expect(store.rules.get("rule-1")?.triggerPrice).toBeCloseTo(392, 6)

  monitor.applyQuote(quote(420))
  expect(store.rules.get("rule-1")?.extremePrice).toBe(420)
  expect(store.rules.get("rule-1")?.triggerPrice).toBeCloseTo(411.6, 6)

  // A pullback that misses the trail leaves it where it is.
  monitor.applyQuote(quote(415))
  expect(store.rules.get("rule-1")?.triggerPrice).toBeCloseTo(411.6, 6)
  expect(triggers).toHaveLength(0)

  monitor.applyQuote(quote(411))
  expect(triggers).toHaveLength(1)
})

test("a close-based rule ignores a wick and fires on the finished candle", async () => {
  const candles = new FakeCandleSource()
  const { monitor, triggers } = await monitorWith(
    [rule({ basis: "CLOSE", interval: "MIN_5" })],
    { candles },
  )

  // A trade through the level is not a close through it.
  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(375))
  expect(triggers).toHaveLength(0)

  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 401, low: 395, close: 398, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 398, high: 399, low: 370, close: 385, volume: null },
    // Still forming, so its close does not count yet.
    { timestamp: NOW, open: 385, high: 386, low: 360, close: 361, volume: null },
  ]
  await monitor.refreshCandleRules()
  expect(candles.requests).toEqual([{ instrumentUid: "instrument-1", interval: "MIN_5", range: "INTRADAY" }])
  expect(triggers).toHaveLength(0)

  // Once a candle closes below the level, the rule fires on its close.
  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 398, high: 399, low: 370, close: 385, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 385, high: 386, low: 360, close: 375, volume: null },
    { timestamp: NOW, open: 375, high: 377, low: 374, close: 376, volume: null },
  ]
  await monitor.refreshCandleRules()
  expect(triggers).toHaveLength(1)
  expect(triggers[0]?.price).toBe(375)
})

test("reports a close-based rule against its candles, not against ticks", async () => {
  const candles = new FakeCandleSource()
  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 401, low: 395, close: 398, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 398, high: 399, low: 390, close: 392, volume: null },
  ]
  const { monitor } = await monitorWith([rule({ basis: "CLOSE", interval: "MIN_5" })], { candles })

  // A contract that never prints a tick is not a broken rule: this one reads
  // candles, and saying "no feed" would send the trader chasing a phantom.
  expect(monitor.views()[0]?.feed).toBe("missing")

  await monitor.refreshCandleRules()
  const view = monitor.views()[0]
  expect(view?.feed).toBe("live")
  expect(view?.lastPrice).toBe(392)
  expect(view?.distancePercent).toBeCloseTo(((380 - 392) / 392) * 100, 6)
})

test("tells the panel to repaint when what a row shows has moved", async () => {
  const candles = new FakeCandleSource()
  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 401, low: 395, close: 398, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 398, high: 399, low: 393, close: 396, volume: null },
  ]
  const store = new FakeStopRuleStore([
    rule({ id: "touch" }),
    rule({ id: "close", basis: "CLOSE", interval: "MIN_5" }),
  ])
  let repaints = 0
  const monitor = new StopMonitor({
    store,
    candles,
    onTrigger: () => {},
    onChange: () => (repaints += 1),
    now: () => NOW,
  })
  await monitor.load()
  monitor.setPositions([position()])
  repaints = 0

  // A tick nothing acts on still moves the distance a touch rule displays.
  monitor.applyQuote(quote(390))
  expect(repaints).toBe(1)

  // And a candle read nothing acts on still moves what a close rule displays.
  // Without this the row freezes on whatever it said when the app started.
  await monitor.refreshCandleRules()
  expect(repaints).toBe(2)
  expect(monitor.views().find((view) => view.rule.id === "close")?.lastPrice).toBe(396)
})

test("refreshes the width an ATR trail follows, but not a standing ATR level", async () => {
  const candles = new FakeCandleSource()
  candles.candles = Array.from({ length: 20 }, (_, index) => ({
    timestamp: NOW - (20 - index) * INTERVAL_MS,
    open: 400,
    high: 402,
    low: 398,
    close: 400,
    volume: null,
  }))
  const standing = rule({ id: "rule-1", kind: "ATR", value: 2, interval: "MIN_5", atrValue: 3 })
  const trailing = rule({ id: "rule-2", kind: "TRAILING_ATR", value: 2, interval: "MIN_5", atrValue: 3 })
  const { monitor, store } = await monitorWith([standing, trailing], { candles })

  await monitor.refreshCandleRules()

  // True range is 4 per candle, so the trail widens to 4; the standing level
  // keeps the reading it was measured with.
  expect(store.rules.get("rule-2")?.atrValue).toBeCloseTo(4, 6)
  expect(store.rules.get("rule-1")?.atrValue).toBe(3)
  expect(store.rules.get("rule-1")?.triggerPrice).toBeCloseTo(394, 6)
})

test("a submitted exit stands down the other levels on that position", async () => {
  const stop = rule({ id: "rule-1", role: "STOP", value: 380 })
  const target = rule({ id: "rule-2", role: "TARGET", value: 420 })
  const { monitor, store } = await monitorWith([stop, target])

  await monitor.resolveTrigger("rule-1", "SUBMITTED", "order-9")
  expect(store.rules.get("rule-1")).toMatchObject({ status: "DONE", exitOrderUid: "order-9" })
  expect(store.rules.get("rule-2")?.status).toBe("PAUSED")
})

test("a cancelled trigger leaves the rule on hold rather than re-arming it", async () => {
  const { monitor, store, triggers } = await monitorWith([rule()])

  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(379))
  expect(triggers).toHaveLength(1)

  await monitor.resolveTrigger("rule-1", "CANCELLED")
  expect(store.rules.get("rule-1")?.status).toBe("PAUSED")

  // Re-arming needs a safe tick again before it can fire.
  await monitor.setStatus("rule-1", "ARMED")
  monitor.applyQuote(quote(378))
  expect(triggers).toHaveLength(1)
  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(378))
  expect(triggers).toHaveLength(2)
})

test("a rule reloaded as triggered never fires on its own", async () => {
  const { monitor, triggers } = await monitorWith([rule({}, { status: "TRIGGERED", triggeredAt: NOW })])

  monitor.applyQuote(quote(390))
  monitor.applyQuote(quote(370))
  expect(triggers).toHaveLength(0)
})

test("reports the symbols it needs ticks for", async () => {
  const { monitor } = await monitorWith([
    rule({ id: "rule-1", symbol: "ASELS" }),
    rule({ id: "rule-2", symbol: "THYAO" }, { status: "DONE" }),
  ])

  expect(monitor.symbols()).toEqual(["ASELS"])
})

test("stops evaluating once destroyed", async () => {
  const { monitor, triggers } = await monitorWith([rule()])

  monitor.applyQuote(quote(390))
  monitor.destroy()
  monitor.applyQuote(quote(370))
  expect(triggers).toHaveLength(0)
})

test("asks for a range wide enough to read each grain", () => {
  // Range and grain are independent now; the range only has to be wide enough
  // that an indicator window has bars to work with.
  expect(rangeForInterval("MIN_5")).toBe("INTRADAY")
  expect(rangeForInterval("HOUR_1")).toBe("MONTH")
  expect(rangeForInterval("DAY_1")).toBe("YEAR")
})
