import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { AccountPosition } from "../trading/account.ts"
import type { StopRuleDraft } from "../trading/stop.ts"
import { StopRuleEditor, type StopRuleEditorOptions } from "./stop-rule-editor.ts"

function key(name: string, sequence?: string): KeyEvent {
  return { name, sequence: sequence ?? name } as KeyEvent
}

function type(editor: StopRuleEditor, digits: string): void {
  for (const digit of digits) editor.handleKey(key(digit, digit))
}

function position(): AccountPosition {
  return {
    uid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    quantity: 2,
    averageCost: 400,
    currentPrice: 400,
    unrealizedProfitLoss: null,
    currency: "TRY",
  }
}

async function mountEditor(overrides: Partial<StopRuleEditorOptions> = {}) {
  const harness = await createTestRenderer({ width: 90, height: 30 })
  const saved: StopRuleDraft[] = []
  let closed = 0
  const editor = new StopRuleEditor(harness.renderer, {
    positions: [position()],
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
function save(editor: StopRuleEditor, steps: number): void {
  for (let step = 0; step < steps; step++) editor.handleKey(key("down"))
  editor.handleKey(key("return"))
}

test("saves a fixed-price stop for the selected position", async () => {
  const { renderer, editor, saved } = await mountEditor()

  type(editor, "380")
  save(editor, 3) // basis → quantity → action

  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    instrumentUid: "instrument-1",
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 380,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 400,
  })

  editor.destroy()
  renderer.destroy()
})

test("measures a percent rule from the position's entry", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  editor.handleKey(key("up")) // value → kind
  editor.handleKey(key("right")) // PRICE → PERCENT
  editor.handleKey(key("down")) // back to value
  type(editor, "2")
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("Distance (%)")
  // 2% under a 400 entry, previewed before it is saved.
  expect(frame).toContain("392,00")

  save(editor, 3)
  expect(saved[0]).toMatchObject({ kind: "PERCENT", value: 2, referencePrice: 400 })

  editor.destroy()
  renderer.destroy()
})

test("asks for a timeframe once the rule needs candles", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  type(editor, "380")
  editor.handleKey(key("down")) // value → basis
  editor.handleKey(key("right")) // TOUCH → CLOSE
  await renderOnce()
  expect(captureCharFrame()).toContain("Timeframe")

  save(editor, 3) // interval → quantity → action
  expect(saved[0]).toMatchObject({ basis: "CLOSE", interval: "MIN_10" })

  editor.destroy()
  renderer.destroy()
})

test("reads the ATR a multiple is measured against", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  editor.handleKey(key("up")) // value → kind
  editor.handleKey(key("right"))
  editor.handleKey(key("right")) // PRICE → PERCENT → ATR
  editor.handleKey(key("down")) // back to value
  type(editor, "2")
  // The ATR read resolves on the next turn.
  await Bun.sleep(0)
  await renderOnce()
  expect(captureCharFrame()).toContain("ATR")

  save(editor, 4) // basis → interval → quantity → action
  expect(saved[0]).toMatchObject({ kind: "ATR", value: 2, interval: "MIN_10", atrValue: 4 })

  editor.destroy()
  renderer.destroy()
})

test("refuses a level the market has already passed", async () => {
  const { renderer, renderOnce, captureCharFrame, editor, saved } = await mountEditor()

  // A stop above a long's market would fire the moment it is saved.
  type(editor, "420")
  save(editor, 3)
  await renderOnce()

  expect(saved).toHaveLength(0)
  expect(captureCharFrame()).toContain("A level below the market is required")

  editor.destroy()
  renderer.destroy()
})

test("escape closes without saving", async () => {
  const { renderer, editor, saved, closed } = await mountEditor()

  type(editor, "380")
  editor.handleKey(key("escape"))

  expect(saved).toHaveLength(0)
  expect(closed()).toBe(1)

  editor.destroy()
  renderer.destroy()
})
