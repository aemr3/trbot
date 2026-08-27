import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import { createTestRenderer } from "@opentui/core/testing"
import type { PortfolioPerformance, PortfolioRange, PortfolioSummary } from "@trbot/trading/account.ts"
import { PortfolioPanel } from "./portfolio-panel.ts"

function key(name: string): KeyEvent {
  return keyEvent(name)
}

const portfolio: PortfolioSummary = {
  currency: "TRY",
  totalCollateral: 20_519.61,
  availableCollateral: 4_399.61,
  dailyProfitLoss: 302.84,
  dailyProfitLossPercent: 1.5,
  periodProfitLoss: 905.43,
  periodProfitLossPercent: 3.95,
}

function performance(overrides: Partial<PortfolioPerformance> = {}): PortfolioPerformance {
  return {
    range: "WEEK",
    points: [
      { date: "2026-08-10", profitLoss: -1_490, profitLossPercent: -7.15, totalCollateral: 19_324.18 },
      { date: "2026-08-11", profitLoss: 941.56, profitLossPercent: 4.87, totalCollateral: 20_265.74 },
      { date: "2026-08-12", profitLoss: 2_979.33, profitLossPercent: 14.7, totalCollateral: 22_045.07 },
    ],
    profitLoss: 905.43,
    profitLossPercent: 3.95,
    ...overrides,
  }
}

async function mountPanel(onRangeChange?: (range: PortfolioRange) => void) {
  const harness = await createTestRenderer({ width: 40, height: 20 })
  const panel = new PortfolioPanel(harness.renderer, { onRangeChange })
  panel.root.width = 40
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
}

test("keeps its range chips inside the panel however narrow it is", async () => {
  // The sidebar narrows with the terminal, and the panel beside it starts one
  // column later: a header wider than the panel must be cut off, not painted
  // over the neighbour.
  const harness = await createTestRenderer({ width: 60, height: 8 })
  const panel = new PortfolioPanel(harness.renderer, {})
  panel.root.width = 28
  harness.renderer.root.add(panel.root)
  await harness.renderOnce()

  const header = harness.captureCharFrame().split("\n").find((line) => line.includes("1W")) ?? ""
  expect(header).toContain("1W")
  expect(header.slice(28).trim()).toBe("")

  harness.renderer.destroy()
})

test("shows the account's figures and the range's own profit", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Portfolio")
  expect(frame).toContain("Collateral  ₺20.519,61")
  expect(frame).toContain("Available   ₺4.399,61")
  expect(frame).toContain("Day P/L     +₺302,84")
  // The period figure is named after the range it covers, because it moves
  // with it.
  expect(frame).toContain("Week P/L    +₺905,43")

  renderer.destroy()
})

test("draws gains above the zero line and losses below it", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()
  const lines = captureCharFrame().split("\n")

  // The zero line, not the panel's own top border.
  const metrics = lines.findIndex((line) => line.includes("Week P/L"))
  const zero = lines.findIndex((line, index) => index > metrics && line.includes("───"))
  expect(zero).toBeGreaterThan(metrics)
  const above = lines.slice(0, zero).filter((line) => line.includes("█")).length
  const below = lines.slice(zero + 1).filter((line) => line.includes("█")).length
  // Two winning days and one losing one, so both halves are drawn.
  expect(above).toBeGreaterThan(0)
  expect(below).toBeGreaterThan(0)
  // The day of each bar sits under it.
  expect(lines.some((line) => line.includes("10") && line.includes("11") && line.includes("12"))).toBeTrue()

  renderer.destroy()
})

test("centers each date under the slot occupied by its bar", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()

  const axis = captureCharFrame().split("\n").find((line) => line.includes("10") && line.includes("11") && line.includes("12")) ?? ""
  expect([axis.indexOf("10"), axis.indexOf("11"), axis.indexOf("12")]).toEqual([5, 19, 32])

  renderer.destroy()
})

test("selects a day from the chart and walks its profit with the keyboard", async () => {
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const metrics = lines.findIndex((line) => line.includes("Week P/L"))
  const zero = lines.findIndex((line, index) => index > metrics && line.includes("───"))
  await mockMouse.click(6, zero)
  await renderOnce()

  const selected = captureCharFrame()
  expect(selected).toContain("10 Aug P/L  -₺1.490,00  -7.15%")
  expect(selected).toContain("│")

  expect(panel.handleKey(key("right"))).toBeTrue()
  await renderOnce()
  expect(captureCharFrame()).toContain("11 Aug P/L  +₺941,56  +4.87%")

  expect(panel.handleKey(key("escape"))).toBeTrue()
  await renderOnce()
  expect(captureCharFrame()).toContain("Week P/L    +₺905,43")

  renderer.destroy()
})

test("does not start text selection when dragging across the performance chart", async () => {
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const metrics = lines.findIndex((line) => line.includes("Week P/L"))
  const zero = lines.findIndex((line, index) => index > metrics && line.includes("───"))
  expect(zero).toBeGreaterThan(metrics)
  await mockMouse.drag(1, zero, 30, zero)
  expect(renderer.getSelection()).toBeNull()

  const labels = lines.findIndex((line) => line.includes("10") && line.includes("11") && line.includes("12"))
  expect(labels).toBeGreaterThan(zero)
  await mockMouse.drag(1, labels, 30, labels)
  expect(renderer.getSelection()).toBeNull()

  renderer.destroy()
})

test("says so rather than drawing an empty field", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance({ points: [] }))
  await Bun.sleep(0)
  await renderOnce()

  expect(captureCharFrame()).toContain("No performance history")

  renderer.destroy()
})

test("reports a range change instead of loading it", async () => {
  const ranges: PortfolioRange[] = []
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel((range) => ranges.push(range))

  panel.showPortfolio(portfolio)
  panel.showPerformance(performance())
  await Bun.sleep(0)
  await renderOnce()

  const initial = captureCharFrame().split("\n")
  const headerY = initial.findIndex((line) => line.includes("1W") && line.includes("1M"))
  await mockMouse.click(initial[headerY]?.indexOf("1M") ?? -1, headerY)
  expect(ranges).toEqual(["MONTH"])
  expect(panel.activeRange).toBe("MONTH")
  expect(renderer.getSelection()).toBeNull()

  await renderOnce()
  const frame = captureCharFrame()
  // The label follows the range immediately, and the old range's bars are
  // dropped rather than left under the new one's heading.
  expect(frame).toContain("Month P/L")
  expect(frame).toContain("Loading performance…")

  // Wrapping backwards from the first range lands on the last.
  panel.handleKey(key("left"))
  panel.handleKey(key("left"))
  expect(panel.activeRange).toBe("ALL_TIME")

  // Anything it does not own falls through to the panel behind it.
  expect(panel.handleKey(key("j"))).toBeFalse()

  renderer.destroy()
})
