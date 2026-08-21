import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { HttpAlerts, HttpMarketMonitors, HttpStopRules } from "@trbot/client/monitors.ts"
import { HttpClient } from "@trbot/client/http.ts"
import type { PriceAlert, PriceAlertStore } from "@trbot/market/alert.ts"
import type { MarketMonitor, MarketMonitorStore } from "@trbot/market/market-monitor.ts"
import { DEFAULT_INTERVALS_BY_RANGE } from "@trbot/market/candle.ts"
import type { StopRule, StopRuleStore } from "@trbot/trading/stop.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { startServer } from "../http/server.ts"
import { serverDeps } from "../http/server.test-fixture.ts"
import { ProviderSession } from "../session.ts"
import { StreamHub } from "../stream-hub.ts"
import type { SocketData } from "../stream-hub.ts"
import { AlertController } from "./alert.ts"
import { MarketMonitorController } from "./market-monitor.ts"
import { StopController } from "./stop.ts"
import { z } from "zod"

const TOKEN = "editing-token"

function emptyAuthSession() {
  return Promise.resolve({
    store: { async get() { return null }, async latest() { return null }, async put() {} },
    close() {},
  })
}

function memoryStopStore(): StopRuleStore {
  const rules = new Map<string, StopRule>()
  return {
    async list() {
      return [...rules.values()]
    },
    async put(rule) {
      rules.set(rule.id, rule)
    },
    async remove(id) {
      rules.delete(id)
    },
  }
}

function memoryAlertStore(): PriceAlertStore {
  const alerts = new Map<string, PriceAlert>()
  return {
    async list() {
      return [...alerts.values()]
    },
    async put(alert) {
      alerts.set(alert.id, alert)
    },
    async remove(id) {
      alerts.delete(id)
    },
  }
}

function memoryMarketMonitorStore(): MarketMonitorStore {
  const monitors = new Map<string, MarketMonitor>()
  return {
    async list() {
      return [...monitors.values()]
    },
    async put(monitor) {
      monitors.set(monitor.id, monitor)
    },
    async remove(id) {
      monitors.delete(id)
    },
  }
}

const STOP_DRAFT = {
  instrumentUid: "future-1",
  symbol: "F_XU0300826",
  displayName: "XU030 08/26",
  side: "LONG",
  role: "STOP",
  kind: "PRICE",
  value: 305,
  basis: "TOUCH",
  interval: null,
  quantity: null,
  referencePrice: 310,
  atrValue: null,
} as const

const ALERT_DRAFT = {
  instrumentUid: "future-1",
  symbol: "F_XU0300826",
  displayName: "XU030 08/26",
  direction: "ABOVE",
  kind: "PRICE",
  value: 320,
  basis: "TOUCH",
  interval: null,
  repeat: "ONCE",
  referencePrice: 310,
  atrValue: null,
} as const

/**
 * A rule the monitor has never heard of is a rule that never fires, so saving
 * has to reach the running monitor and not just the database. These drive the
 * real routes and then ask the monitor itself what it is watching.
 */
describe("editing the rules the server evaluates", () => {
  let server: Server<SocketData>
  let client: HttpClient
  let stops: StopController
  let alerts: AlertController
  let marketMonitors: MarketMonitorController
  let broadcasts: string[]

  beforeEach(() => {
    broadcasts = []
    const session = new ProviderSession({ openAuthSession: emptyAuthSession, credentials: null })
    stops = new StopController({
      store: memoryStopStore(),
      exits: () => null,
      broadcast: (event) => broadcasts.push(event.type),
    })
    alerts = new AlertController({
      store: memoryAlertStore(),
      broadcast: (event) => broadcasts.push(event.type),
    })
    marketMonitors = new MarketMonitorController({
      store: memoryMarketMonitorStore(),
      onTrigger: async () => {},
    })
    server = startServer(
      { host: "127.0.0.1", port: 0, token: TOKEN, tls: null },
      serverDeps({
        session,
        hub: new StreamHub(session),
        alerts,
        marketMonitors,
        stops,
        backlog: () => [],
        onDecision: () => {},
      }),
    )
    client = new HttpClient({ url: `http://127.0.0.1:${server.port}`, token: TOKEN })
  })

  afterEach(() => {
    void server.stop(true)
    stops.destroy()
    alerts.destroy()
    marketMonitors.destroy()
  })

  test("a saved stop rule is watched by the monitor, not only stored", async () => {
    const rules = new HttpStopRules(client)
    const saved = await rules.save(STOP_DRAFT)

    expect(saved.id).toBeTruthy()
    // The monitor's own view of what it is watching, which is what actually
    // decides whether the rule can ever fire.
    expect(stops.rules.views().map((view) => view.rule.id)).toEqual([saved.id])
    expect(stops.symbols()).toContain("F_XU0300826")
    // And clients are told, which is what puts it on the screen.
    expect(broadcasts).toContain("changed")
  })

  test("a saved alert is watched by the monitor, not only stored", async () => {
    const saved = await new HttpAlerts(client).save(ALERT_DRAFT)

    expect(alerts.alerts.views().map((view) => view.alert.id)).toEqual([saved.id])
    expect(alerts.symbols()).toContain("F_XU0300826")
    expect(broadcasts).toContain("changed")
  })

  test("a removed stop rule stops being watched", async () => {
    const rules = new HttpStopRules(client)
    const saved = await rules.save(STOP_DRAFT)
    await rules.remove(saved.id)

    expect(stops.rules.views()).toBeEmpty()
    expect(stops.symbols()).toBeEmpty()
  })

  test("a removed alert stops being watched", async () => {
    const remote = new HttpAlerts(client)
    const saved = await remote.save(ALERT_DRAFT)
    await remote.remove(saved.id)

    expect(alerts.alerts.views()).toBeEmpty()
  })

  test("chat monitor routes expose and cancel monitors without creating price alerts", async () => {
    const saved = await marketMonitors.save({
      ...ALERT_DRAFT,
      chatSessionId: "chat-1",
      onTrigger: "Refresh the quote and reassess the setup.",
    })
    const remote = new HttpMarketMonitors(client)

    expect(await remote.list()).toEqual([saved])
    expect(await remote.list("chat-1")).toEqual([saved])
    expect(await remote.list("chat-2")).toEqual([])
    expect(alerts.list()).toEqual([])

    await remote.remove(saved.id)
    expect(await remote.list("chat-1")).toEqual([])
  })

  test("list routes omit closed stops, alerts, and market monitors", async () => {
    const rules = new HttpStopRules(client)
    const stop = await rules.save(STOP_DRAFT)
    await rules.setStatus(stop.id, "DONE")

    const alertClient = new HttpAlerts(client)
    const alert = await alertClient.save(ALERT_DRAFT)
    await alertClient.setStatus(alert.id, "TRIGGERED")

    const monitor = await marketMonitors.save({
      ...ALERT_DRAFT,
      chatSessionId: "chat-1",
      onTrigger: "Refresh the quote and reassess the setup.",
    })
    await marketMonitors.setStatus(monitor.id, "TRIGGERED")

    expect(await rules.list()).toEqual([])
    expect(await alertClient.list()).toEqual([])
    expect(await new HttpMarketMonitors(client).list("chat-1")).toEqual([])
    expect(stops.rules.rule(stop.id)?.status).toBe("DONE")
    expect(alerts.alerts.alert(alert.id)?.status).toBe("TRIGGERED")
  })

  test("pausing a rule reaches the monitor that would otherwise fire it", async () => {
    const rules = new HttpStopRules(client)
    const saved = await rules.save(STOP_DRAFT)
    await rules.setStatus(saved.id, "PAUSED")

    expect(stops.rules.rule(saved.id)?.status).toBe("PAUSED")
  })

  test("editing a rule keeps its identity rather than making a second one", async () => {
    const rules = new HttpStopRules(client)
    const saved = await rules.save(STOP_DRAFT)
    const edited = await rules.save({ ...STOP_DRAFT, id: saved.id, value: 300 })

    expect(edited.id).toBe(saved.id)
    expect(edited.createdAt).toBe(saved.createdAt)
    expect(stops.rules.views()).toHaveLength(1)
    expect(stops.rules.rule(saved.id)?.value).toBe(300)
  })

  // A close-based rule has no ticks to fall back on, so between saving it and
  // the next candle poll it shows no level at all — armed but reading as broken.
  test("a saved rule reads its candles immediately rather than waiting for the poll", async () => {
    const reads: string[] = []
    const controller = new StopController({
      store: memoryStopStore(),
      candles: {
        async loadCandles(instrumentUid) {
          reads.push(instrumentUid)
          return {
            instrumentUid,
            candles: [],
            interval: "DAY_1",
            range: "MONTH",
            availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
            intervalMs: null,
            currency: "TRY",
          }
        },
      },
      exits: () => null,
      broadcast: () => {},
    })

    await controller.save({ ...STOP_DRAFT, basis: "CLOSE", interval: "DAY_1" })
    // The read is started but not awaited, so let it land.
    await Bun.sleep(5)

    expect(reads).toContain("future-1")
    controller.destroy()
  })

  test("a draft the server cannot trust is refused before it becomes a rule", async () => {
    const failure = await client
      .put(ROUTES.stops, z.unknown(), { body: { ...STOP_DRAFT, side: "SIDEWAYS" } })
      .then(() => null, (cause: unknown) => cause instanceof Error ? cause : null)

    expect(failure?.message).toContain("side")
    expect(stops.rules.views()).toBeEmpty()
  })

  /**
   * Well-formed and still unusable. Each of these types cleanly and then either
   * never fires or fails at the moment it tries to exit, which is the worst
   * time to find out — so the server runs the same check the editor does.
   */
  test.each([
    ["a fractional number of contracts", { quantity: 2.5 }, /whole number/],
    ["no contracts at all", { quantity: 0 }, /whole number/],
    ["a negative size", { quantity: -3 }, /whole number/],
    ["a close-based rule with no timeframe", { basis: "CLOSE", interval: null }, /timeframe/],
    ["an ATR rule with no timeframe", { kind: "ATR", interval: null, atrValue: 4 }, /timeframe/],
    ["an ATR rule with no ATR", { kind: "ATR", interval: "DAY_1", atrValue: null }, /ATR/],
    ["an offset rule with nothing to measure from", { kind: "PERCENT", referencePrice: null }, /average cost/],
  ])("refuses %s", async (_name, overrides, expected) => {
    const failure = await client
      .put(ROUTES.stops, z.unknown(), { body: { ...STOP_DRAFT, ...overrides } })
      .then(() => null, (cause: unknown) => cause instanceof Error ? cause : null)

    expect(failure?.message).toMatch(expected)
    expect(stops.rules.views()).toBeEmpty()
  })

  test("an alert the server cannot evaluate is refused the same way", async () => {
    const failure = await client
      .put(ROUTES.alerts, z.unknown(), { body: { ...ALERT_DRAFT, basis: "CLOSE", interval: null } })
      .then(() => null, (cause: unknown) => cause instanceof Error ? cause : null)

    expect(failure?.message).toMatch(/timeframe/)
    expect(alerts.alerts.views()).toBeEmpty()
  })
})
