import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import { createTestRenderer } from "@opentui/core/testing"
import { createMarketMonitor, type MarketMonitor } from "@trbot/market/market-monitor.ts"
import { MarketMonitorModal } from "./market-monitor-modal.ts"

const NOW = 1_786_000_000_000

function key(name: string): KeyEvent {
  return keyEvent(name)
}

function monitor(patch: Partial<MarketMonitor> = {}): MarketMonitor {
  return {
    ...createMarketMonitor({
      id: "monitor-1",
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
      chatSessionId: "chat-1",
      onTrigger: "Refresh the quote and reassess the breakout.",
    }, NOW),
    ...patch,
  }
}

test("shows a chat's monitors and requires two d presses to cancel", async () => {
  const harness = await createTestRenderer({ width: 100, height: 26 })
  const cancelled: string[] = []
  const modal = new MarketMonitorModal(harness.renderer, {
    monitors: [monitor()],
    onCancel: (id) => cancelled.push(id),
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)
  await harness.renderOnce()

  const frame = harness.captureCharFrame()
  expect(frame).toContain("Market monitors")
  expect(frame).toContain("ASELS")
  expect(frame).toContain("above 420,00")
  expect(frame).toContain("Refresh the quote and reassess the breakout.")

  modal.handleKey(key("d"))
  await harness.renderOnce()
  expect(harness.captureCharFrame()).toContain("Press d again to cancel ASELS's monitor")
  expect(cancelled).toEqual([])

  modal.handleKey(key("d"))
  expect(cancelled).toEqual(["monitor-1"])

  modal.destroy()
  harness.renderer.destroy()
})

test("explains when the open chat has no monitors", async () => {
  const harness = await createTestRenderer({ width: 80, height: 20 })
  const modal = new MarketMonitorModal(harness.renderer, {
    monitors: [],
    onCancel: () => {},
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)
  await harness.renderOnce()

  expect(harness.captureCharFrame()).toContain("No market monitors were created in this chat.")

  modal.destroy()
  harness.renderer.destroy()
})
