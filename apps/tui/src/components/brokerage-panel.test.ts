import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import type { BrokerageDistribution, BrokerageSide } from "@trbot/market/brokerage.ts"
import type { SettlementAnalysis, SettlementMode } from "@trbot/market/settlement.ts"
import { BrokeragePanel, type BrokerView, type BrokeragePanelOptions } from "./brokerage-panel.ts"

const presets = [
  { range: { start: null, end: null }, isDefault: true },
  { range: { start: "2026-08-07", end: "2026-08-13" }, isDefault: false },
]

function distribution(side: BrokerageSide, count = 12): BrokerageDistribution {
  return {
    side,
    shares: Array.from({ length: count }, (_, index) => ({
      brokerage: `House ${index + 1} Yatırım`,
      netLots: 1_000_000 - index * 50_000,
      averagePrice: 386.41 + index,
      percentage: 40 - index * 3,
      grossLots: 4_000_000 - index * 100_000,
      volumeShare: 12 - index,
    })),
    topCount: 5,
    topPercentage: 93.1,
    topLots: 2_907_973,
    otherLots: 215_732,
    lastUpdate: "Son Güncelleme: 13 Ağustos 15:37",
    live: true,
    presets,
    availableDates: ["2026-08-13", "2026-08-12"],
  }
}

// The provider signs a shed position; the panel is expected to sign rows from
// the active view instead, so the fixture keeps the provider's convention.
function analysis(mode: SettlementMode, count = 12): SettlementAnalysis {
  const direction = mode === "LOST" ? -1 : 1
  return {
    mode,
    holdings: Array.from({ length: count }, (_, index) => ({
      brokerage: `House ${index + 1} Yatırım`,
      percentage: 40 - index * 3,
      percentageChange: mode === "HELD" ? null : direction * (1.5 + index),
      lotChange: mode === "HELD" ? null : direction * (900_000 - index * 50_000),
      totalLot: mode === "HELD" ? 496_359_440 - index * 1_000_000 : null,
    })),
    topCount: 5,
    topPercentage: 70.1,
    topLots: 826_142_663,
    otherLots: 352_458_757,
    lastUpdate: "Son Güncelleme: 13 Ağustos 15:37",
    live: false,
    presets,
    availableDates: ["2026-08-13", "2026-08-12"],
    unavailableMessage: null,
  }
}

function key(name: string): KeyEvent {
  return keyEvent(name)
}

// The watchlist owns the panel's box, so the test sizes it the same way.
async function mountPanel(options: BrokeragePanelOptions = {}, height = 21) {
  const harness = await createTestRenderer({ width: 48, height })
  const panel = new BrokeragePanel(harness.renderer, options)
  panel.root.width = 48
  panel.root.height = height
  harness.renderer.root.add(panel.root)
  panel.setDistributionEntitled(true)
  panel.setSettlementEntitled(true)
  return { ...harness, panel }
}

// Walks the tabs to the requested view, which is how the panel is driven.
function selectView(panel: BrokeragePanel, view: BrokerView): void {
  while (panel.activeView !== view) panel.handleKey(key("right"))
}

test("ranks the houses under the leading-share summary", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showDistribution(distribution("BUYER"))
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Buyers")
  expect(frame).toContain("Top 5 93,1%")
  expect(frame).toContain("6,9% Other")
  expect(frame).toContain("2.907.973")
  expect(frame).toContain("Broker")
  expect(frame).toContain("House 1                1.000.000 40,0%  386,41")
  // The leading houses sit above a rule, separated from the tail.
  const lines = frame.split("\n")
  const fifth = lines.findIndex((line) => line.includes("House 5"))
  // The panel's own top border also draws a rule, so look past the fifth house.
  const divider = lines.findIndex((line, index) => index > fifth && line.includes("──────"))
  expect(divider - fifth).toBe(1)
  expect(lines[divider + 1]).toContain("House 6")

  renderer.destroy()
})

test("switches views and asks for the new one to be loaded", async () => {
  const views: BrokerView[] = []
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({
    onViewChange: (view) => views.push(view),
  })
  panel.showDistribution(distribution("BUYER"))

  panel.handleKey(key("right"))
  await renderOnce()

  expect(views).toEqual(["SELLER"])
  expect(panel.activeView).toBe("SELLER")
  // The buyers' table is cleared rather than shown under the sellers' tab.
  expect(captureCharFrame()).toContain("Loading broker distribution…")

  panel.showDistribution(distribution("SELLER"))
  await renderOnce()
  expect(captureCharFrame()).toContain("House 1")

  // The settlement views sit beyond the two flow tabs and wrap back round.
  panel.handleKey(key("right"))
  expect(panel.activeView).toBe("HELD")
  await renderOnce()
  expect(captureCharFrame()).toContain("Loading settlement analysis…")

  panel.handleKey(key("left"))
  expect(panel.activeView).toBe("SELLER")
  expect(views).toEqual(["SELLER", "HELD", "SELLER"])

  renderer.destroy()
})

test("switches views on a click and opens the popup from the range label", async () => {
  const views: BrokerView[] = []
  let opened = 0
  let focusRequests = 0
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel({
    onViewChange: (view) => views.push(view),
    onOpenDateRange: () => { opened++ },
    onFocusRequest: () => { focusRequests++ },
  })
  panel.showDistribution(distribution("BUYER"))
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const tabsY = lines.findIndex((line) => line.includes("Sellers"))
  await mockMouse.click((lines[tabsY] ?? "").indexOf("Gained"), tabsY)

  expect(views).toEqual(["GAINED"])
  expect(panel.activeView).toBe("GAINED")
  expect(focusRequests).toBeGreaterThan(0)

  // The range keeps its own row above the tabs.
  const rangeY = lines.findIndex((line) => line.includes("Today"))
  await mockMouse.click((lines[rangeY] ?? "").indexOf("Today"), rangeY)
  expect(opened).toBe(1)

  renderer.destroy()
})

test("ignores a reading that arrives for another view", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showDistribution(distribution("SELLER"))
  panel.showSettlement(analysis("HELD"))
  await renderOnce()

  expect(captureCharFrame()).toContain("Loading broker distribution…")
  renderer.destroy()
})

test("scrolls the tail while the leading houses stay pinned", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({}, 21)
  panel.showDistribution(distribution("BUYER"))
  await renderOnce()
  expect(captureCharFrame()).toContain("↓ 2 more")

  panel.handleKey(key("down"))
  panel.handleKey(key("down"))
  await renderOnce()
  const scrolled = captureCharFrame()

  expect(scrolled).toContain("House 1 ")
  expect(scrolled).toContain("House 12")
  expect(scrolled).not.toContain("House 6 ")

  panel.handleKey(key("home"))
  await renderOnce()
  expect(captureCharFrame()).toContain("House 6 ")

  renderer.destroy()
})

test("asks for the date popup on d and names the active range", async () => {
  let opened = 0
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({
    onOpenDateRange: () => { opened++ },
  })
  panel.showDistribution(distribution("BUYER"))

  panel.handleKey(key("d"))
  expect(opened).toBe(1)

  panel.setRange({ start: "2026-08-07", end: "2026-08-13" })
  await renderOnce()
  expect(captureCharFrame()).toContain("Last 7 days")

  panel.setRange({ start: "2026-08-11", end: null })
  await renderOnce()
  expect(captureCharFrame()).toContain("11 Aug")

  renderer.destroy()
})

test("shows the standing position behind the held view", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  selectView(panel, "HELD")

  panel.showSettlement(analysis("HELD"))
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Top 5 70,1%")
  expect(frame).toContain("826.142.663")
  expect(frame).toContain("Total lot")
  expect(frame).toContain("496.359.440")
  // A standing position has no traded price and no move of its own.
  expect(frame).not.toContain("Avg")
  expect(frame).not.toContain("Δ lot")

  renderer.destroy()
})

/**
 * A custody figure is the float itself, not a session's trading: a large bank
 * holds billions of lots. The share beside it has to survive that.
 */
test("keeps the share column beside a ten-digit custody figure", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  selectView(panel, "HELD")

  const held = analysis("HELD", 1)
  panel.showSettlement({
    ...held,
    holdings: [{ ...held.holdings[0]!, brokerage: "Garanti Bank.", percentage: 76.02, totalLot: 1_866_236_548 }],
  })
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("1.866.236.548")
  expect(frame).toContain("76,0%")

  renderer.destroy()
})

test("signs a settled move from its own view rather than the provider", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  selectView(panel, "GAINED")
  panel.showSettlement(analysis("GAINED"))
  await renderOnce()
  const gained = captureCharFrame()
  expect(gained).toContain("Δ lot")
  expect(gained).toContain("+900.000")
  expect(gained).toContain("+1,5%")

  selectView(panel, "LOST")
  panel.showSettlement(analysis("LOST"))
  await renderOnce()
  const lost = captureCharFrame()
  // The provider already signs these; the row must not read "--900.000".
  expect(lost).toContain("-900.000")
  expect(lost).toContain("-1,5%")
  expect(lost).not.toContain("--")

  renderer.destroy()
})

test("passes on the provider's note when a range has not settled yet", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  selectView(panel, "HELD")

  panel.showSettlement({
    ...analysis("HELD", 0),
    unavailableMessage: "13 Ağustos takas verisi henüz yayınlanmadı.",
  })
  await renderOnce()

  expect(captureCharFrame()).toContain("13 Ağustos takas verisi")
  renderer.destroy()
})

test("locks each view against its own entitlement", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setSettlementEntitled(false)

  panel.showDistribution(distribution("BUYER"))
  await renderOnce()
  expect(captureCharFrame()).toContain("House 1")

  selectView(panel, "HELD")
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("Settlement analysis is a paid feature")
  expect(frame).not.toContain("House 1")

  renderer.destroy()
})

test("reports a locked panel while the entitlement is unknown", async () => {
  const harness = await createTestRenderer({ width: 48, height: 21 })
  const panel = new BrokeragePanel(harness.renderer)
  panel.root.width = 48
  panel.root.height = 21
  harness.renderer.root.add(panel.root)

  await harness.renderOnce()
  expect(harness.captureCharFrame()).toContain("Checking broker distribution access")

  panel.setDistributionEntitled(false)
  await harness.renderOnce()
  const frame = harness.captureCharFrame()

  expect(frame).toContain("Broker distribution is a paid feature")
  expect(frame).not.toContain("House 1")

  harness.renderer.destroy()
})

test("explains when the contract has no cash-equity broker analytics", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.showDistribution(distribution("BUYER"))

  panel.setInstrumentSupported(false)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("cash-equity underlying")
  expect(frame).not.toContain("House 1")

  renderer.destroy()
})
