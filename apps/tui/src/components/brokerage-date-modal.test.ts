import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import type { BrokerageDatePreset, BrokerageDateRange } from "@trbot/market/broker-calendar.ts"
import { BrokerageDateModal } from "./brokerage-date-modal.ts"

const presets: BrokerageDatePreset[] = [
  { range: { start: null, end: null }, isDefault: true },
  { range: { start: "2026-08-12", end: "2026-08-13" }, isDefault: false },
]
const availableDates = ["2026-08-13", "2026-08-12", "2026-08-11"]

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

async function mountModal() {
  const harness = await createTestRenderer({ width: 60, height: 26 })
  const selected: BrokerageDateRange[] = []
  let closed = 0
  const modal = new BrokerageDateModal(harness.renderer, {
    presets,
    availableDates,
    range: { start: null, end: null },
    onSelect: (range) => selected.push(range),
    onClose: () => { closed++ },
  })
  harness.renderer.root.add(modal.root)
  return { ...harness, modal, selected, closed: () => closed }
}

// Enter activates the highlighted row, so stepping down N times reaches row N.
function activateRow(modal: BrokerageDateModal, index: number): void {
  for (let step = 0; step < index; step++) modal.handleKey(key("down"))
  modal.handleKey(key("return"))
}

test("offers the provider presets alongside the day and range pickers", async () => {
  const { renderer, renderOnce, captureCharFrame } = await mountModal()

  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Broker date range")
  expect(frame).toContain("Today")
  expect(frame).toContain("Last 2 days")
  expect(frame).toContain("12 – 13 Aug")
  expect(frame).toContain("Single day…")
  expect(frame).toContain("3 days")
  expect(frame).toContain("Custom range…")

  renderer.destroy()
})

test("applies a preset range", async () => {
  const { renderer, renderOnce, modal, selected } = await mountModal()
  await renderOnce()

  activateRow(modal, 1)

  expect(selected).toEqual([{ start: "2026-08-12", end: "2026-08-13" }])
  renderer.destroy()
})

test("picks a single day from the provider's trading days", async () => {
  const { renderer, renderOnce, captureCharFrame, modal, selected } = await mountModal()
  await renderOnce()

  activateRow(modal, 2)
  await renderOnce()
  expect(captureCharFrame()).toContain("Pick a day")
  expect(captureCharFrame()).toContain("11 Aug")

  activateRow(modal, 1)

  expect(selected).toEqual([{ start: "2026-08-12", end: null }])
  renderer.destroy()
})

test("builds a custom range and never lets it close before it opens", async () => {
  const { renderer, renderOnce, captureCharFrame, modal, selected } = await mountModal()
  await renderOnce()

  activateRow(modal, 3)
  await renderOnce()
  expect(captureCharFrame()).toContain("pick the first day")

  // Choose the oldest day, so only it and the newer ones remain selectable.
  activateRow(modal, 2)
  await renderOnce()
  const closing = captureCharFrame()
  expect(closing).toContain("pick the last day (from 11 Aug)")
  expect(closing).toContain("13 Aug")

  activateRow(modal, 0)

  expect(selected).toEqual([{ start: "2026-08-11", end: "2026-08-13" }])
  renderer.destroy()
})

test("escape steps back to the presets before it closes the modal", async () => {
  const { renderer, renderOnce, captureCharFrame, modal, closed } = await mountModal()
  await renderOnce()

  activateRow(modal, 2)
  modal.handleKey(key("escape"))
  await renderOnce()

  expect(captureCharFrame()).toContain("Broker date range")
  expect(closed()).toBe(0)

  modal.handleKey(key("escape"))
  expect(closed()).toBe(1)

  renderer.destroy()
})
