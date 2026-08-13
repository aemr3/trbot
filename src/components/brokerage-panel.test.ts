import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import type { BrokerageDistribution, BrokerageSide } from "../market/brokerage.ts"
import { BrokeragePanel, type BrokeragePanelOptions } from "./brokerage-panel.ts"

function distribution(side: BrokerageSide, count = 12): BrokerageDistribution {
  return {
    side,
    shares: Array.from({ length: count }, (_, index) => ({
      brokerage: `House ${index + 1} Yatırım`,
      netLots: 1_000_000 - index * 50_000,
      averagePrice: 386.41 + index,
      percentage: 40 - index * 3,
    })),
    topCount: 5,
    topPercentage: 93.1,
    topLots: 2_907_973,
    otherLots: 215_732,
    lastUpdate: "Son Güncelleme: 13 Ağustos 15:37",
    live: true,
    presets: [
      { range: { start: null, end: null }, isDefault: true },
      { range: { start: "2026-08-07", end: "2026-08-13" }, isDefault: false },
    ],
    availableDates: ["2026-08-13", "2026-08-12"],
  }
}

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

// The watchlist owns the panel's box, so the test sizes it the same way.
async function mountPanel(options: BrokeragePanelOptions = {}, height = 20) {
  const harness = await createTestRenderer({ width: 48, height })
  const panel = new BrokeragePanel(harness.renderer, options)
  panel.root.width = 48
  panel.root.height = height
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
}

test("ranks the houses under the leading-share summary", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)

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

test("switches sides and asks for the new one to be loaded", async () => {
  const sides: BrokerageSide[] = []
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({
    onSideChange: (side) => sides.push(side),
  })
  panel.setEntitled(true)
  panel.showDistribution(distribution("BUYER"))

  panel.handleKey(key("right"))
  await renderOnce()

  expect(sides).toEqual(["SELLER"])
  expect(panel.activeSide).toBe("SELLER")
  // The buyers' table is cleared rather than shown under the sellers' tab.
  expect(captureCharFrame()).toContain("Loading broker distribution…")

  panel.showDistribution(distribution("SELLER"))
  await renderOnce()
  expect(captureCharFrame()).toContain("House 1")

  renderer.destroy()
})

test("switches sides on a click and opens the popup from the range label", async () => {
  const sides: BrokerageSide[] = []
  let opened = 0
  let focusRequests = 0
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel({
    onSideChange: (side) => sides.push(side),
    onOpenDateRange: () => { opened++ },
    onFocusRequest: () => { focusRequests++ },
  })
  panel.setEntitled(true)
  panel.showDistribution(distribution("BUYER"))
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const toolbarY = lines.findIndex((line) => line.includes("Sellers"))
  const toolbar = lines[toolbarY] ?? ""
  await mockMouse.click(toolbar.indexOf("Sellers"), toolbarY)

  expect(sides).toEqual(["SELLER"])
  expect(panel.activeSide).toBe("SELLER")
  expect(focusRequests).toBeGreaterThan(0)

  await mockMouse.click(toolbar.indexOf("Today"), toolbarY)
  expect(opened).toBe(1)

  renderer.destroy()
})

test("ignores a distribution that arrives for the other side", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)

  panel.showDistribution(distribution("SELLER"))
  await renderOnce()

  expect(captureCharFrame()).toContain("Loading broker distribution…")
  renderer.destroy()
})

test("scrolls the tail while the leading houses stay pinned", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({}, 20)
  panel.setEntitled(true)
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
  panel.setEntitled(true)
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

test("reports a locked panel when the subscription does not include it", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  await renderOnce()
  expect(captureCharFrame()).toContain("Checking broker distribution access")

  panel.setEntitled(false)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("paid feature")
  expect(frame).not.toContain("House 1")

  renderer.destroy()
})
