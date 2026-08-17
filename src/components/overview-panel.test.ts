import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import { buildOverviewDigest } from "../market/overview.ts"
import { OverviewPanel, type OverviewPanelOptions } from "./overview-panel.ts"

const DIGEST = buildOverviewDigest({
  mode: "INTRADAY",
  instrument: { symbol: "ASELS", displayName: null, lastPrice: 390 },
  range: { start: null, end: null },
})

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

// The watchlist owns the panel's box, so the test sizes it the same way.
async function mountPanel(options: OverviewPanelOptions = {}, height = 14) {
  const harness = await createTestRenderer({ width: 46, height })
  const panel = new OverviewPanel(harness.renderer, options)
  panel.root.width = 46
  panel.root.height = height
  harness.renderer.root.add(panel.root)
  panel.setEntitled(true)
  return { ...harness, panel }
}

test("streams the commentary with a cursor and settles when finished", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.startStreaming()
  panel.appendCommentary("Alpha accumulates ")
  panel.appendCommentary("under the offer.")
  // Deltas repaint through the coalescer, one event-loop turn later.
  await Bun.sleep(0)
  await renderOnce()
  let frame = captureCharFrame()

  expect(frame).toContain("AI Overview")
  expect(frame).toContain("Alpha accumulates under the offer.▍")

  panel.finishCommentary()
  await renderOnce()
  frame = captureCharFrame()
  expect(frame).toContain("Alpha accumulates under the offer.")
  expect(frame).not.toContain("▍")

  renderer.destroy()
})

test("renders cached snapshots in one shot", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showSnapshot({
    digest: DIGEST,
    commentary: "Custody grew while the tape stayed quiet.",
    generatedAt: Date.UTC(2026, 7, 16, 11, 30),
  })
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Custody grew while the tape stayed quiet.")
  expect(frame).not.toContain("▍")

  renderer.destroy()
})

test("holds the last review on screen until the new one is written", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showSnapshot({ digest: DIGEST, commentary: "Old reading.", generatedAt: 0 })
  panel.setCollecting()
  await renderOnce()
  expect(captureCharFrame()).toContain("Old reading.")
  expect(captureCharFrame()).toContain("gathering…")

  panel.startStreaming()
  panel.appendCommentary("Fresh reading.")
  await Bun.sleep(0)
  await renderOnce()
  let frame = captureCharFrame()
  expect(frame).toContain("Old reading.")
  expect(frame).not.toContain("Fresh reading.")
  expect(frame).toContain("writing…")

  panel.finishCommentary()
  await renderOnce()
  frame = captureCharFrame()
  expect(frame).toContain("Fresh reading.")
  expect(frame).not.toContain("Old reading.")
  expect(frame).not.toContain("writing…")

  renderer.destroy()
})

test("keeps the last review under a failed run", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.showSnapshot({ digest: DIGEST, commentary: "Old reading.", generatedAt: 0 })
  panel.startStreaming()
  panel.appendCommentary("Half a rea")
  panel.showError("Overview failed: timeout")
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Overview failed: timeout")
  expect(frame).toContain("Old reading.")
  expect(frame).not.toContain("Half a rea")

  renderer.destroy()
})

test("walks the pre-generation states", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  await renderOnce()
  expect(captureCharFrame()).toContain("Waiting for market data…")

  panel.setCollecting()
  await renderOnce()
  expect(captureCharFrame()).toContain("Gathering broker data…")

  panel.showError("Overview failed: timeout")
  await renderOnce()
  expect(captureCharFrame()).toContain("Overview failed: timeout")

  renderer.destroy()
})

test("maps entitlement and connection problems to their hints", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()

  panel.setEntitled(false)
  await renderOnce()
  expect(captureCharFrame()).toContain("Broker data requires a subscription.")

  panel.setEntitled(true)
  panel.showError("ChatGPT is not connected")
  await renderOnce()
  // The hint word-wraps in the narrow panel, so match its wrap-safe prefix.
  expect(captureCharFrame()).toContain("Connect ChatGPT with A")

  // Connecting the account clears the hint back to idle.
  panel.setConnected(true)
  await renderOnce()
  expect(captureCharFrame()).toContain("Waiting for market data…")

  renderer.destroy()
})

test("r regenerates and arrows scroll without leaking to the screen", async () => {
  let generated = 0
  const { renderer, panel } = await mountPanel({ onGenerate: () => (generated += 1) })

  expect(panel.handleKey(key("r"))).toBeTrue()
  expect(panel.handleKey(key("return"))).toBeTrue()
  expect(generated).toBe(2)
  expect(panel.handleKey(key("down"))).toBeTrue()
  expect(panel.handleKey(key("q"))).toBeFalse()

  renderer.destroy()
})

test("left and right walk the two horizons, intraday first", async () => {
  const modes: string[] = []
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel({
    onModeChange: (mode) => modes.push(mode),
  })

  await renderOnce()
  expect(captureCharFrame()).toContain("AI Overview   Intraday   Daily")
  expect(panel.activeMode).toBe("INTRADAY")

  expect(panel.handleKey(key("right"))).toBeTrue()
  expect(panel.activeMode).toBe("DAILY")
  expect(panel.handleKey(key("l"))).toBeTrue()
  expect(panel.activeMode).toBe("INTRADAY")
  expect(modes).toEqual(["DAILY", "INTRADAY"])

  renderer.destroy()
})
