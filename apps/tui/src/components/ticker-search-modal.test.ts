import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { InputRenderable, type KeyEvent } from "@opentui/core"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { keyEvent } from "../key-event.test-fixture.ts"
import { TickerSearchModal } from "./ticker-search-modal.ts"

const instruments: ViopInstrument[] = [
  {
    uid: "u1",
    symbol: "F_XU0300826",
    displayName: "XU030",
    underlyingSymbol: "XU030",
    lastPrice: 15_910,
    changePercent: 0.4,
    volume: 2_000_000_000,
    currency: "TRY",
  },
  {
    uid: "u2",
    symbol: "F_THYAO0826",
    displayName: "THYAO",
    underlyingSymbol: "THYAO",
    lastPrice: 312.45,
    changePercent: -1.05,
    volume: 1_000_000_000,
    currency: "TRY",
  },
]

function key(name: string, sequence = name): KeyEvent {
  return keyEvent(name, { sequence })
}

test("filters contracts and switches to the highlighted ticker", async () => {
  const harness = await createTestRenderer({ width: 100, height: 28 })
  const selected: string[] = []
  const modal = new TickerSearchModal(harness.renderer, {
    instruments,
    currentUid: "u1",
    onSelect: (instrument) => selected.push(instrument.uid),
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)
  modal.mount()
  await harness.renderOnce()

  const initial = harness.captureCharFrame()
  expect(initial).toContain("Ticker search")
  expect(initial).toContain("2 contracts")
  expect(initial).toContain("XU030")
  expect(initial).toContain("THYAO")

  await harness.mockInput.typeText("thy")
  await harness.renderOnce()
  const filtered = harness.captureCharFrame()
  expect(filtered).toContain("1 matching · 2 contracts")
  expect(filtered).toContain("THYAO")
  expect(filtered).not.toContain("F_XU0300826")

  modal.handleKey(key("return"))
  expect(selected).toEqual(["u2"])

  modal.destroy()
  harness.renderer.destroy()
})

test("shows an empty result and closes with Escape", async () => {
  const harness = await createTestRenderer({ width: 80, height: 22 })
  let closed = 0
  const modal = new TickerSearchModal(harness.renderer, {
    instruments,
    currentUid: null,
    onSelect: () => {},
    onClose: () => {
      closed++
    },
  })
  harness.renderer.root.add(modal.root)
  modal.mount()

  await harness.mockInput.typeText("missing")
  await harness.renderOnce()
  expect(harness.captureCharFrame()).toContain("No matching tickers.")

  modal.handleKey(key("escape"))
  expect(closed).toBe(1)

  modal.destroy()
  harness.renderer.destroy()
})

test("restores focus to the control behind it when destroyed", async () => {
  const harness = await createTestRenderer({ width: 80, height: 22 })
  const previous = new InputRenderable(harness.renderer, { width: 20 })
  harness.renderer.root.add(previous)
  previous.focus()
  const modal = new TickerSearchModal(harness.renderer, {
    instruments,
    currentUid: null,
    onSelect: () => {},
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)

  modal.mount()
  expect(harness.renderer.currentFocusedRenderable).not.toBe(previous)

  modal.destroy()
  expect(harness.renderer.currentFocusedRenderable).toBe(previous)
  harness.renderer.destroy()
})
