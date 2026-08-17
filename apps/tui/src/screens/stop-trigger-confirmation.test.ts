import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { AccountPosition } from "@trbot/trading/account.ts"
import type { StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"
import { createStopRule } from "@trbot/trading/stop.ts"
import { StopTriggerConfirmation } from "./stop-trigger-confirmation.ts"

const NOW = 1_786_000_000_000

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

function position(): AccountPosition {
  return {
    uid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    quantity: 2,
    averageCost: 400,
    currentPrice: 379,
    unrealizedProfitLoss: null,
    currency: "TRY",
  }
}

function event(): StopTriggerEvent {
  const rule = createStopRule(
    {
      instrumentUid: "instrument-1",
      symbol: "F_ASELS0826",
      displayName: "ASELS",
      side: "LONG",
      role: "STOP",
      kind: "PRICE",
      value: 380,
      basis: "TOUCH",
      interval: null,
      quantity: null,
      referencePrice: 400,
      atrValue: null,
    },
    NOW,
  )
  return { rule, position: position(), price: 379, quantity: 2, side: "SELL", priceAgeMs: 0 }
}

async function mountModal(overrides: { countdownMs?: number; tickMs?: number } = {}) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  let confirmed = 0
  let cancelled = 0
  const modal = new StopTriggerConfirmation(harness.renderer, {
    event: event(),
    countdownMs: overrides.countdownMs ?? 10_000,
    tickMs: overrides.tickMs ?? 5,
    onConfirm: () => (confirmed += 1),
    onCancel: () => (cancelled += 1),
  })
  harness.renderer.root.add(modal.root)
  return { ...harness, modal, counts: () => ({ confirmed, cancelled }) }
}

test("states the exit it is about to send", async () => {
  const { renderer, renderOnce, captureCharFrame, modal } = await mountModal()

  modal.mount()
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Stop reached")
  expect(frame).toContain("ASELS")
  expect(frame).toContain("SELL 2 at the exchange limit")
  expect(frame).toContain("Sending in")

  modal.destroy()
  renderer.destroy()
})

test("sends once when the countdown runs out", async () => {
  const { renderer, modal, counts } = await mountModal({ countdownMs: 10, tickMs: 5 })

  modal.mount()
  await Bun.sleep(60)

  expect(counts()).toEqual({ confirmed: 1, cancelled: 0 })

  modal.destroy()
  renderer.destroy()
})

test("Enter sends immediately and cannot double-send", async () => {
  const { renderer, modal, counts } = await mountModal({ countdownMs: 5_000 })

  modal.mount()
  expect(modal.handleKey(key("return"))).toBeTrue()
  expect(modal.handleKey(key("return"))).toBeTrue()

  expect(counts()).toEqual({ confirmed: 1, cancelled: 0 })

  modal.destroy()
  renderer.destroy()
})

test("Esc cancels and stops the countdown", async () => {
  const { renderer, modal, counts } = await mountModal({ countdownMs: 20, tickMs: 5 })

  modal.mount()
  expect(modal.handleKey(key("escape"))).toBeTrue()
  await Bun.sleep(60)

  expect(counts()).toEqual({ confirmed: 0, cancelled: 1 })

  modal.destroy()
  renderer.destroy()
})

test("p holds the countdown until it is released", async () => {
  const { renderer, renderOnce, captureCharFrame, modal, counts } = await mountModal({ countdownMs: 20, tickMs: 5 })

  modal.mount()
  modal.handleKey(key("p"))
  await Bun.sleep(60)
  await renderOnce()

  expect(counts().confirmed).toBe(0)
  expect(captureCharFrame()).toContain("Countdown held")

  // Releasing lets the clock run out again.
  modal.handleKey(key("p"))
  await Bun.sleep(60)
  expect(counts().confirmed).toBe(1)

  modal.destroy()
  renderer.destroy()
})

test("a destroyed modal never sends", async () => {
  const { renderer, modal, counts } = await mountModal({ countdownMs: 20, tickMs: 5 })

  modal.mount()
  modal.destroy()
  await Bun.sleep(60)

  expect(counts()).toEqual({ confirmed: 0, cancelled: 0 })

  renderer.destroy()
})
