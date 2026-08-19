import { expect, test } from "bun:test"
import { createPriceAlert, type PriceAlert, type PriceAlertStore } from "@trbot/market/alert.ts"
import type { AlertTriggerEvent } from "@trbot/market/alert-monitor.ts"
import { AlertController } from "./alert.ts"

const NOW = 1_786_000_000_000

function agentAlert(patch: Partial<PriceAlert> = {}): PriceAlert {
  return {
    ...createPriceAlert({
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
      onTrigger: "Reassess the breakout.",
    }, NOW),
    ...patch,
  }
}

function memoryStore(seed: PriceAlert[]): PriceAlertStore {
  const values = new Map(seed.map((alert) => [alert.id, alert]))
  return {
    list: async () => [...values.values()],
    put: async (alert) => { values.set(alert.id, alert) },
    remove: async (id) => { values.delete(id) },
  }
}

test("retries an interrupted agent wake-up when alerts are loaded", async () => {
  const wakes: AlertTriggerEvent[] = []
  const fired = agentAlert({
    status: "TRIGGERED",
    triggeredAt: NOW + 1_000,
    triggeredPrice: 421,
    triggerId: "trigger-1",
  })
  const controller = new AlertController({
    store: memoryStore([fired]),
    broadcast: () => {},
    onAgentTrigger: async (event) => { wakes.push(event) },
  })

  await controller.load()
  await Promise.resolve()

  expect(wakes).toEqual([{ alert: fired, price: 421, priceAgeMs: 0 }])
  controller.destroy()
})

test("a live crossing wakes the agent as well as broadcasting the alert", async () => {
  const wakes: AlertTriggerEvent[] = []
  const broadcasts: string[] = []
  let resolveWake!: (event: AlertTriggerEvent) => void
  const wake = new Promise<AlertTriggerEvent>((resolve) => { resolveWake = resolve })
  const controller = new AlertController({
    store: memoryStore([agentAlert()]),
    broadcast: (event) => { broadcasts.push(event.type) },
    onAgentTrigger: async (event) => {
      wakes.push(event)
      resolveWake(event)
    },
    now: () => NOW,
  })
  await controller.load()

  controller.applyQuote({ symbol: "F_ASELS0826", lastPrice: 400, sessionStatus: null, timestamp: NOW })
  controller.applyQuote({ symbol: "F_ASELS0826", lastPrice: 421, sessionStatus: null, timestamp: NOW })
  await wake

  expect(wakes).toHaveLength(1)
  expect(wakes[0]?.alert.triggerId).toEqual(expect.any(String))
  expect(broadcasts).toContain("triggered")
  controller.destroy()
})
