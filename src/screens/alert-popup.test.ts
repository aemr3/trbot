import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { AlertTriggerEvent } from "../market/alert-monitor.ts"
import { createPriceAlert } from "../market/alert.ts"
import { AlertPopup } from "./alert-popup.ts"

const NOW = 1_786_000_000_000

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

function event(): AlertTriggerEvent {
  const alert = createPriceAlert(
    {
      id: "alert-1",
      instrumentUid: "instrument-1",
      symbol: "F_ASELS0826",
      displayName: "ASELS",
      direction: "ABOVE",
      kind: "PRICE",
      value: 420,
      basis: "TOUCH",
      interval: null,
      referencePrice: 400,
      atrValue: null,
    },
    NOW,
  )
  return { alert: { ...alert, status: "TRIGGERED", triggeredPrice: 421 }, price: 421, priceAgeMs: 0 }
}

async function mountPopup() {
  const harness = await createTestRenderer({ width: 90, height: 30 })
  const dismissed: number[] = []
  const rearmed: number[] = []
  const popup = new AlertPopup(harness.renderer, {
    event: event(),
    onDismiss: () => dismissed.push(1),
    onRearm: () => rearmed.push(1),
  })
  harness.renderer.root.add(popup.root)
  return { ...harness, popup, dismissed, rearmed }
}

test("states what was reached and that nothing was traded", async () => {
  const { renderer, renderOnce, captureCharFrame, popup } = await mountPopup()

  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("ASELS rose to")
  expect(frame).toContain("421,00")
  // The whole point of an alert: it is a notice, never an order.
  expect(frame).toContain("Nothing was traded")

  popup.destroy()
  renderer.destroy()
})

test("r re-arms and anything else dismisses", async () => {
  const { renderer, popup, dismissed, rearmed } = await mountPopup()

  popup.handleKey(key("r"))
  expect(rearmed).toHaveLength(1)
  expect(dismissed).toHaveLength(0)

  // An alert popup must never be the thing standing between the trader and
  // the keyboard, so every other key closes it.
  popup.handleKey(key("j"))
  expect(dismissed).toHaveLength(1)

  popup.destroy()
  renderer.destroy()
})

test("keeps the market line current while it stands open", async () => {
  const { renderer, renderOnce, captureCharFrame, popup } = await mountPopup()

  popup.applyQuote({ symbol: "F_ASELS0826", lastPrice: 431, sessionStatus: null, timestamp: NOW })
  await renderOnce()
  expect(captureCharFrame()).toContain("431,00")

  // A tick for another contract is not this alert's market.
  popup.applyQuote({ symbol: "F_THYAO0826", lastPrice: 99, sessionStatus: null, timestamp: NOW })
  await renderOnce()
  expect(captureCharFrame()).not.toContain("99,00")

  popup.destroy()
  renderer.destroy()
})
