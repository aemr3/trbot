import { expect, test } from "bun:test"
import { AlertMonitor, alertRangeForInterval, type AlertTriggerEvent } from "./alert-monitor.ts"
import { createPriceAlert, type PriceAlert, type PriceAlertDraft, type PriceAlertStore } from "./alert.ts"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "./candle.ts"
import type { QuoteUpdate } from "./quote-stream.ts"

const NOW = 1_786_000_000_000
const INTERVAL_MS = 600_000 // 10 minutes

class FakePriceAlertStore implements PriceAlertStore {
  readonly alerts = new Map<string, PriceAlert>()

  constructor(seed: PriceAlert[] = []) {
    for (const alert of seed) this.alerts.set(alert.id, alert)
  }

  async list(): Promise<PriceAlert[]> {
    return [...this.alerts.values()]
  }
  async put(alert: PriceAlert): Promise<void> {
    this.alerts.set(alert.id, alert)
  }
  async remove(id: string): Promise<void> {
    this.alerts.delete(id)
  }
}

class FakeCandleSource implements CandleSource {
  requests: Array<{ instrumentUid: string; interval: CandleInterval; range: CandleRange }> = []
  candles: Candle[] = []

  async loadCandles(instrumentUid: string, range: CandleRange, interval: CandleInterval): Promise<CandleSeries> {
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

function alert(overrides: Partial<PriceAlertDraft> = {}, patch: Partial<PriceAlert> = {}): PriceAlert {
  const draft: PriceAlertDraft = {
    id: "alert-1",
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
  return { ...createPriceAlert(draft, NOW), ...patch }
}

function quote(price: number, timestamp = NOW): QuoteUpdate {
  return { symbol: "F_ASELS0826", lastPrice: price, sessionStatus: null, timestamp }
}

async function monitorWith(
  alerts: PriceAlert[],
  overrides: { candles?: CandleSource; stalePriceMs?: number } = {},
) {
  const store = new FakePriceAlertStore(alerts)
  const triggers: AlertTriggerEvent[] = []
  const monitor = new AlertMonitor({
    store,
    create: createPriceAlert,
    onTrigger: (event) => triggers.push(event),
    now: () => NOW,
    ...overrides,
  })
  await monitor.load()
  return { monitor, store, triggers }
}

test("announces a crossing once, after the market has been seen on the near side", async () => {
  const { monitor, store, triggers } = await monitorWith([alert()])

  // The first tick only establishes that the level is not already passed.
  monitor.applyQuote(quote(425))
  expect(triggers).toHaveLength(0)

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(421))
  expect(triggers).toHaveLength(1)
  expect(triggers[0]).toMatchObject({ price: 421 })
  expect(store.alerts.get("alert-1")).toMatchObject({ status: "TRIGGERED", triggeredPrice: 421 })

  // A fired alert is spent: more ticks beyond the level say nothing.
  monitor.applyQuote(quote(430))
  expect(triggers).toHaveLength(1)
})

test("uses a live quote seen before saving to arm the first crossing", async () => {
  const store = new FakePriceAlertStore()
  const triggers: AlertTriggerEvent[] = []
  const monitor = new AlertMonitor({
    store,
    create: createPriceAlert,
    onTrigger: (event) => triggers.push(event),
    now: () => NOW,
  })

  monitor.applyQuote(quote(410))
  await monitor.saveAlert({
    id: "saved-after-quote",
    instrumentUid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    direction: "ABOVE",
    kind: "PRICE",
    value: 420,
    basis: "TOUCH",
    interval: null,
    repeat: "ONCE",
    referencePrice: 410,
    atrValue: null,
  })

  monitor.applyQuote(quote(421))

  expect(triggers).toHaveLength(1)
  expect(triggers[0]?.price).toBe(421)
})

test("fires without any position, unlike a stop", async () => {
  // Nothing is ever set on this monitor but the alert itself; an alert watches
  // the market, not a holding.
  const { monitor, triggers } = await monitorWith([alert({ direction: "BELOW", value: 380 })])

  monitor.applyQuote(quote(400))
  monitor.applyQuote(quote(379))
  expect(triggers).toHaveLength(1)
})

test("ignores a tick too old to believe", async () => {
  const { monitor, triggers } = await monitorWith([alert()], { stalePriceMs: 10_000 })

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(425, NOW - 60_000))
  expect(triggers).toHaveLength(0)

  const views = monitor.views()
  expect(views[0]?.feed).toBe("stale")
  expect(views[0]?.level).toBe(420)
})

test("persists a trailing level as it advances", async () => {
  const { monitor, store, triggers } = await monitorWith([
    alert({ kind: "TRAILING_PERCENT", value: 2, direction: "BELOW" }),
  ])

  monitor.applyQuote(quote(400))
  expect(store.alerts.get("alert-1")?.triggerPrice).toBeCloseTo(392, 6)

  monitor.applyQuote(quote(420))
  expect(store.alerts.get("alert-1")?.extremePrice).toBe(420)
  expect(store.alerts.get("alert-1")?.triggerPrice).toBeCloseTo(411.6, 6)
  expect(triggers).toHaveLength(0)

  monitor.applyQuote(quote(411))
  expect(triggers).toHaveLength(1)
})

test("a close-based alert ignores a wick and fires on the finished candle", async () => {
  const candles = new FakeCandleSource()
  const { monitor, triggers } = await monitorWith([alert({ basis: "CLOSE", interval: "MIN_10" })], { candles })

  // A trade through the level is not a close through it.
  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(430))
  expect(triggers).toHaveLength(0)

  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 405, low: 399, close: 402, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 402, high: 430, low: 401, close: 405, volume: null },
    // Still forming, so its close does not count yet.
    { timestamp: NOW, open: 405, high: 440, low: 404, close: 439, volume: null },
  ]
  await monitor.refreshCandleAlerts()
  expect(candles.requests).toEqual([{ instrumentUid: "instrument-1", interval: "MIN_10", range: "INTRADAY" }])
  expect(triggers).toHaveLength(0)

  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 402, high: 430, low: 401, close: 405, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 405, high: 440, low: 404, close: 425, volume: null },
    { timestamp: NOW, open: 425, high: 427, low: 424, close: 426, volume: null },
  ]
  await monitor.refreshCandleAlerts()
  expect(triggers).toHaveLength(1)
  expect(triggers[0]?.price).toBe(425)
})

test("reports a close-based alert against its candles, not against ticks", async () => {
  const candles = new FakeCandleSource()
  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 405, low: 399, close: 402, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 402, high: 410, low: 401, close: 408, volume: null },
  ]
  const { monitor } = await monitorWith([alert({ basis: "CLOSE", interval: "MIN_10" })], { candles })

  // A contract that never prints a tick is not a broken alert: this one reads
  // candles, and saying "no feed" would send the trader chasing a phantom.
  expect(monitor.views()[0]?.feed).toBe("missing")

  await monitor.refreshCandleAlerts()
  const view = monitor.views()[0]
  expect(view?.feed).toBe("live")
  expect(view?.lastPrice).toBe(408)
})

test("tells the panel to repaint when what a row shows has moved", async () => {
  const candles = new FakeCandleSource()
  candles.candles = [
    { timestamp: NOW - 2 * INTERVAL_MS, open: 400, high: 405, low: 399, close: 402, volume: null },
    { timestamp: NOW - INTERVAL_MS, open: 402, high: 410, low: 401, close: 406, volume: null },
  ]
  const store = new FakePriceAlertStore([
    alert({ id: "touch" }),
    alert({ id: "close", basis: "CLOSE", interval: "MIN_10" }),
  ])
  let repaints = 0
  const monitor = new AlertMonitor({
    store,
    create: createPriceAlert,
    candles,
    onTrigger: () => {},
    onChange: () => (repaints += 1),
    now: () => NOW,
  })
  await monitor.load()
  repaints = 0

  // A tick nothing acts on still moves the distance a touch alert displays.
  monitor.applyQuote(quote(410))
  expect(repaints).toBe(1)

  // And a candle read nothing acts on still moves what a close alert displays.
  await monitor.refreshCandleAlerts()
  expect(repaints).toBe(2)
  expect(monitor.views().find((view) => view.alert.id === "close")?.lastPrice).toBe(406)
})

test("re-arming clears the fired reading and waits for the near side again", async () => {
  const { monitor, store, triggers } = await monitorWith([alert()])

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(421))
  expect(triggers).toHaveLength(1)

  await monitor.setStatus("alert-1", "ARMED")
  expect(store.alerts.get("alert-1")).toMatchObject({
    status: "ARMED",
    triggeredAt: null,
    triggeredPrice: null,
    triggerId: null,
  })

  // Still beyond the level, so it waits rather than firing straight back.
  monitor.applyQuote(quote(422))
  expect(triggers).toHaveLength(1)
  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(422))
  expect(triggers).toHaveLength(2)
})

test("a repeating alert stays armed and announces the next crossing too", async () => {
  const { monitor, store, triggers } = await monitorWith([alert({ repeat: "ALWAYS" })])

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(421))
  expect(triggers).toHaveLength(1)
  // It records what it saw without going spent, so it needs no re-arming.
  expect(store.alerts.get("alert-1")).toMatchObject({ status: "ARMED", triggeredPrice: 421 })

  // A market sitting beyond the level rings once per crossing, not per tick:
  // the price has to come back to the near side first.
  monitor.applyQuote(quote(430))
  monitor.applyQuote(quote(425))
  expect(triggers).toHaveLength(1)

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(422))
  expect(triggers).toHaveLength(2)
  expect(triggers[1]?.price).toBe(422)
})

test("a paused alert stops watching, and is not asked for ticks", async () => {
  const { monitor, triggers } = await monitorWith([alert()])

  await monitor.setStatus("alert-1", "PAUSED")
  expect(monitor.symbols()).toEqual([])

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(430))
  expect(triggers).toHaveLength(0)
})

test("an alert reloaded as fired never announces itself again", async () => {
  const { monitor, triggers } = await monitorWith([
    alert({}, { status: "TRIGGERED", triggeredAt: NOW, triggeredPrice: 421 }),
  ])

  monitor.applyQuote(quote(410))
  monitor.applyQuote(quote(430))
  expect(triggers).toHaveLength(0)
})

test("lists the newest alert first", async () => {
  const { monitor } = await monitorWith([
    alert({ id: "older" }, { createdAt: NOW - 60_000 }),
    alert({ id: "newer" }, { createdAt: NOW }),
  ])

  expect(monitor.views().map((view) => view.alert.id)).toEqual(["newer", "older"])
})

test("stops evaluating once destroyed", async () => {
  const { monitor, triggers } = await monitorWith([alert()])

  monitor.applyQuote(quote(410))
  monitor.destroy()
  monitor.applyQuote(quote(430))
  expect(triggers).toHaveLength(0)
})

test("asks for the range that serves each futures grain", () => {
  expect(alertRangeForInterval("MIN_10")).toBe("INTRADAY")
  expect(alertRangeForInterval("HOUR_1")).toBe("WEEK")
  // A grain the feed never serves falls back to the session rather than
  // silently asking for a year of candles.
  expect(alertRangeForInterval("MIN_5")).toBe("INTRADAY")
})
