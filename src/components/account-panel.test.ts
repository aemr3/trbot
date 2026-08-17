import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { StopRuleView } from "../trading/stop-monitor.ts"
import { createStopRule, type StopRule, type StopRuleDraft } from "../trading/stop.ts"
import { AccountPanel, type AccountPanelOptions } from "./account-panel.ts"

const NOW = 1_786_000_000_000

function key(name: string): KeyEvent {
  return { name } as KeyEvent
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
async function mountPanel(options: AccountPanelOptions = {}) {
  const harness = await createTestRenderer({ width: 60, height: 10 })
  const panel = new AccountPanel(harness.renderer, options)
  panel.root.width = 60
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
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
