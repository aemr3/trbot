import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { PriceAlertDraft } from "@trbot/market/alert.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { AlertEditor, type AlertEditorOptions } from "./alert-editor.ts"

function key(name: string, sequence?: string): KeyEvent {
  return { name, sequence: sequence ?? name } as KeyEvent
}

function type(editor: AlertEditor, digits: string): void {
  for (const digit of digits) editor.handleKey(key(digit, digit))
}

function instrument(): ViopInstrument {
  return {
    uid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    underlyingSymbol: "ASELS",
    lastPrice: 400,
    changePercent: 1,
    volume: 1_000,
    currency: "TRY",
  }
}

async function mountEditor(overrides: Partial<AlertEditorOptions> = {}) {
  const harness = await createTestRenderer({ width: 90, height: 30 })
  const saved: PriceAlertDraft[] = []
  let closed = 0
  const editor = new AlertEditor(harness.renderer, {
    instruments: [instrument()],
    lastPrice: () => 400,
    atr: async () => 4,
    onSave: (draft) => saved.push(draft),
    onClose: () => (closed += 1),
    ...overrides,
  })
  harness.renderer.root.add(editor.root)
  editor.mount()
  return { ...harness, editor, saved, closed: () => closed }
}

/** Walks from the value field down to the save action and presses it. */
function save(editor: AlertEditor, steps: number): void {
  for (let step = 0; step < steps; step++) editor.handleKey(key("down"))
  editor.handleKey(key("return"))
}

test("saves a fixed-price alert on the selected contract", async () => {
  const { renderer, editor, saved } = await mountEditor()

  type(editor, "420")
  save(editor, 3) // basis → repeat → action

  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    instrumentUid: "instrument-1",
    symbol: "F_ASELS0826",
    direction: "ABOVE",
    kind: "PRICE",
    value: 420,
    basis: "TOUCH",
    interval: null,
    referencePrice: 400,
  })

  editor.destroy()
  renderer.destroy()
})

test("watches the other side once the direction is flipped", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  editor.handleKey(key("up")) // value → kind
  editor.handleKey(key("up")) // kind → direction
  editor.handleKey(key("right")) // ABOVE → BELOW
  await renderOnce()
  expect(captureCharFrame()).toContain("Price falls to the level")

  editor.handleKey(key("down"))
  editor.handleKey(key("down")) // back to value
  type(editor, "380")
  save(editor, 3)
  expect(saved[0]).toMatchObject({ direction: "BELOW", value: 380 })

  editor.destroy()
  renderer.destroy()
})

test("measures a percent alert from the market and previews the level", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  editor.handleKey(key("up")) // value → kind
  editor.handleKey(key("right")) // PRICE → PERCENT
  editor.handleKey(key("down")) // back to value
  type(editor, "5")
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("Distance (%)")
  // 5% over a 400 market, previewed before it is saved.
  expect(frame).toContain("420,00")

  save(editor, 3)
  expect(saved[0]).toMatchObject({ kind: "PERCENT", value: 5, referencePrice: 400 })

  editor.destroy()
  renderer.destroy()
})

test("asks for a timeframe once the alert needs candles", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  type(editor, "420")
  editor.handleKey(key("down")) // value → basis
  editor.handleKey(key("right")) // TOUCH → CLOSE
  await renderOnce()
  expect(captureCharFrame()).toContain("Timeframe")

  save(editor, 3) // interval → repeat → action
  expect(saved[0]).toMatchObject({ basis: "CLOSE", interval: "MIN_10" })

  editor.destroy()
  renderer.destroy()
})

test("offers firing once or on every crossing", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  type(editor, "420")
  editor.handleKey(key("down")) // value → basis
  editor.handleKey(key("down")) // basis → repeat
  await renderOnce()
  expect(captureCharFrame()).toContain("Once, then stop")

  editor.handleKey(key("right"))
  await renderOnce()
  expect(captureCharFrame()).toContain("Every time it crosses")

  editor.handleKey(key("down")) // repeat → action
  editor.handleKey(key("return"))
  expect(saved[0]).toMatchObject({ repeat: "ALWAYS", value: 420 })

  editor.destroy()
  renderer.destroy()
})

test("refuses a level the market has already passed", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  // An alert above a market already above it would fire on the next tick and
  // tell the trader nothing.
  type(editor, "380")
  save(editor, 3)
  await renderOnce()

  expect(saved).toHaveLength(0)
  expect(captureCharFrame()).toContain("A level above the market is required")

  editor.destroy()
  renderer.destroy()
})

test("escape closes without saving", async () => {
  const { renderer, editor, saved, closed } = await mountEditor()

  type(editor, "420")
  editor.handleKey(key("escape"))

  expect(saved).toHaveLength(0)
  expect(closed()).toBe(1)

  editor.destroy()
  renderer.destroy()
})
