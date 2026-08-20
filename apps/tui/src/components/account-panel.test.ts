import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import { createTestRenderer } from "@opentui/core/testing"
import type { PriceAlertView } from "@trbot/market/alert-monitor.ts"
import type { AccountPosition, AccountSnapshot } from "@trbot/trading/account.ts"
import { createPriceAlert } from "@trbot/market/alert.ts"
import type { StopRuleView } from "@trbot/trading/stop-monitor.ts"
import { createStopRule, type StopRule, type StopRuleDraft } from "@trbot/trading/stop.ts"
import { AccountPanel, type AccountPanelOptions } from "./account-panel.ts"

const NOW = 1_786_000_000_000

function key(name: string): KeyEvent {
  return keyEvent(name)
}

function rule(overrides: Partial<StopRuleDraft> = {}, patch: Partial<StopRule> = {}): StopRule {
  const draft: StopRuleDraft = {
    id: "rule-1",
    instrumentUid: "instrument-1",
    symbol: "F_ASELS0826",
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

function view(rule: StopRule, overrides: Partial<StopRuleView> = {}): StopRuleView {
  return {
    rule,
    level: rule.triggerPrice,
    lastPrice: 400,
    distancePercent: -5,
    feed: "live",
    hasPosition: true,
    ...overrides,
  }
}

// The watchlist gives the panel a fixed eight rows; the test matches it.
async function mountPanel(options: AccountPanelOptions = {}, width = 60) {
  const harness = await createTestRenderer({ width, height: 10 })
  const panel = new AccountPanel(harness.renderer, options)
  panel.root.width = width
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
}

function snapshot(positions: AccountPosition[]): AccountSnapshot {
  return {
    portfolio: {
      currency: "TRY",
      totalCollateral: 20_000,
      availableCollateral: 15_000,
      dailyProfitLoss: 0,
      dailyProfitLossPercent: 0,
      periodProfitLoss: 0,
      periodProfitLossPercent: 0,
    },
    performance: { range: "WEEK", points: [], profitLoss: 0, profitLossPercent: 0 },
    orders: [],
    positions,
    updatedAt: NOW,
  }
}

test("lists stop rules with their level, distance and state", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("stops")
  panel.showStopRules([
    view(rule()),
    view(rule({ id: "rule-2", role: "TARGET", value: 440 }), { level: 440, distancePercent: 10 }),
  ])
  // showStopRules repaints through the coalescer, one event-loop turn later.
  await Bun.sleep(0)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Stops")
  expect(frame).toContain("ASELS")
  expect(frame).toContain("380,00")
  expect(frame).toContain("armed")
  expect(frame).toContain("440,00")

  panel.destroy()
  renderer.destroy()
})

test("shows why a rule is not watching", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("stops")
  panel.showStopRules([
    view(rule(), { feed: "stale" }),
    view(rule({ id: "rule-2" }), { hasPosition: false }),
  ])
  // showStopRules repaints through the coalescer, one event-loop turn later.
  await Bun.sleep(0)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("stale")
  expect(frame).toContain("no position")

  panel.destroy()
  renderer.destroy()
})

test("names the feed a rule actually reads when it is missing", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("stops")
  // A close-based rule never reads the tick stream, so "no feed" would send the
  // trader looking at a stream this rule does not use.
  panel.showStopRules([view(rule({ basis: "CLOSE", interval: "MIN_10" }), { feed: "missing" })])
  await Bun.sleep(0)
  await renderOnce()

  expect(captureCharFrame()).toContain("no candles")

  panel.destroy()
  renderer.destroy()
})

test("invites a first rule when there are none", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("stops")
  panel.showStopRules([])
  await renderOnce()

  expect(captureCharFrame()).toContain("No stop rules. Press n to add one.")

  panel.destroy()
  renderer.destroy()
})

test("reports rule actions instead of taking them", async () => {
  const created: number[] = []
  const edited: string[] = []
  const toggled: string[] = []
  const { renderer, renderOnce, panel } = await mountPanel({
    onStopCreate: () => created.push(1),
    onStopEdit: (view) => edited.push(view.rule.id),
    onStopToggle: (view) => toggled.push(view.rule.id),
  })

  panel.selectTab("stops")
  panel.showStopRules([view(rule()), view(rule({ id: "rule-2" }))])
  await renderOnce()

  expect(panel.handleKey(key("n"))).toBeTrue()
  expect(created).toHaveLength(1)

  // j/k move the selection on this tab rather than scrolling.
  expect(panel.handleKey(key("j"))).toBeTrue()
  expect(panel.selectedStop()?.rule.id).toBe("rule-2")
  expect(panel.handleKey(key("k"))).toBeTrue()
  expect(panel.selectedStop()?.rule.id).toBe("rule-1")

  expect(panel.handleKey(key("e"))).toBeTrue()
  expect(edited).toEqual(["rule-1"])
  expect(panel.handleKey(key("space"))).toBeTrue()
  expect(toggled).toEqual(["rule-1"])

  // Deleting belongs to the screen, which owns the confirmation.
  expect(panel.handleKey(key("d"))).toBeFalse()

  panel.destroy()
  renderer.destroy()
})

test("offers no stop selection from the other tabs", async () => {
  const { renderer, renderOnce, panel } = await mountPanel()

  panel.showStopRules([view(rule())])
  await renderOnce()

  expect(panel.selectedStop()).toBeNull()
  // The letters belong to the other tabs while they are showing.
  expect(panel.handleKey(key("n"))).toBeFalse()

  panel.destroy()
  renderer.destroy()
})

test("shows the levels protecting a position on its own row", async () => {
  const positions: AccountPosition[] = [
    {
      uid: "instrument-1",
      symbol: "F_ASELS0826",
      displayName: "ASELS",
      quantity: 2,
      averageCost: 400,
      currentPrice: 405,
      unrealizedProfitLoss: 500,
      currency: "TRY",
      multiplier: 1,
    },
  ]
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(
    { source: { loadAccount: async () => snapshot(positions) } },
    80,
  )

  await panel.refresh()
  panel.showStopRules([
    // Out of order and mixed with rules that are not watching, to prove the row
    // shows the loss side first and leaves the rest to the stops tab.
    view(rule({ id: "rule-2", role: "TARGET", value: 440 }), { level: 440 }),
    view(rule()),
    view(rule({ id: "rule-3", value: 370 }), { level: 370, rule: rule({ id: "rule-3" }, { status: "PAUSED" }) }),
    view(rule({ id: "rule-4", instrumentUid: "instrument-9", symbol: "F_TUPRS0826" }), { level: 111 }),
  ])
  await Bun.sleep(0)
  await renderOnce()
  const row = captureCharFrame().split("\n").find((line) => line.includes("ASELS")) ?? ""

  expect(row).toContain("S 380,00")
  expect(row).toContain("T 440,00")
  expect(row.indexOf("S 380,00")).toBeLessThan(row.indexOf("T 440,00"))
  // A paused rule and another position's rule stay off this row.
  expect(row).not.toContain("370,00")
  expect(row).not.toContain("111,00")

  panel.destroy()
  renderer.destroy()
})

function alertView(overrides: Partial<PriceAlertView> = {}): PriceAlertView {
  const alert = createPriceAlert(
    {
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
    },
    NOW,
  )
  return { alert, level: 420, lastPrice: 400, distancePercent: 5, feed: "live", ...overrides }
}

test("lists price alerts with the side they watch", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("alerts")
  panel.showPriceAlerts([
    alertView(),
    alertView({
      alert: { ...alertView().alert, id: "alert-2", direction: "BELOW", status: "TRIGGERED", triggeredPrice: 380 },
      level: 380,
      distancePercent: -5,
    }),
  ])
  // showPriceAlerts repaints through the coalescer, one event-loop turn later.
  await Bun.sleep(0)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Alerts")
  expect(frame).toContain("420,00")
  expect(frame).toContain("armed")
  // A fired alert reads as fired, not as something still being watched for.
  expect(frame).toContain("fired")

  panel.destroy()
  renderer.destroy()
})

test("reports alert actions instead of taking them", async () => {
  const created: number[] = []
  const edited: string[] = []
  const toggled: string[] = []
  const { renderer, renderOnce, panel } = await mountPanel({
    onAlertCreate: () => created.push(1),
    onAlertEdit: (view) => edited.push(view.alert.id),
    onAlertToggle: (view) => toggled.push(view.alert.id),
  })

  panel.selectTab("alerts")
  const second = alertView({ alert: { ...alertView().alert, id: "alert-2" } })
  panel.showPriceAlerts([alertView(), second])
  await renderOnce()

  expect(panel.handleKey(key("n"))).toBeTrue()
  expect(created).toHaveLength(1)

  expect(panel.handleKey(key("j"))).toBeTrue()
  expect(panel.selectedAlert()?.alert.id).toBe("alert-2")

  expect(panel.handleKey(key("e"))).toBeTrue()
  expect(edited).toEqual(["alert-2"])
  expect(panel.handleKey(key("space"))).toBeTrue()
  expect(toggled).toEqual(["alert-2"])

  // Deleting belongs to the screen, which owns the confirmation.
  expect(panel.handleKey(key("d"))).toBeFalse()
  // And the stops tab's selection stays out of it.
  expect(panel.selectedStop()).toBeNull()

  panel.destroy()
  renderer.destroy()
})

test("invites a first alert when there are none", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("alerts")
  panel.showPriceAlerts([])
  await renderOnce()

  expect(captureCharFrame()).toContain("No price alerts. Press n to add one.")

  panel.destroy()
  renderer.destroy()
})

test("switching between the two rule tabs does not leave the other's rows behind", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.selectTab("stops")
  panel.showStopRules([view(rule())])
  await Bun.sleep(0)
  await renderOnce()
  expect(captureCharFrame()).toContain("380,00")

  panel.selectTab("alerts")
  panel.showPriceAlerts([alertView()])
  await Bun.sleep(0)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("420,00")
  expect(frame).not.toContain("380,00")

  panel.destroy()
  renderer.destroy()
})
