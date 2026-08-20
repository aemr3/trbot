import { expect, test } from "bun:test"
import {
  createMarketMonitor,
  type MarketMonitor,
  type MarketMonitorStore,
} from "@trbot/market/market-monitor.ts"
import type { MarketMonitorTriggerEvent } from "./market-monitor.ts"
import { MarketMonitorController } from "./market-monitor.ts"

const NOW = 1_786_000_000_000

function monitor(patch: Partial<MarketMonitor> = {}): MarketMonitor {
  return {
    ...createMarketMonitor({
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

function memoryStore(seed: MarketMonitor[]): MarketMonitorStore {
  const values = new Map(seed.map((item) => [item.id, item]))
  return {
    list: async () => [...values.values()],
    put: async (item) => { values.set(item.id, item) },
    remove: async (id) => { values.delete(id) },
  }
}

test("retries an interrupted chat wake-up when monitors are loaded", async () => {
  const wakes: MarketMonitorTriggerEvent[] = []
  const fired = monitor({
    status: "TRIGGERED",
    triggeredAt: NOW + 1_000,
    triggeredPrice: 421,
    triggerId: "trigger-1",
  })
  const controller = new MarketMonitorController({
    store: memoryStore([fired]),
    onTrigger: async (event) => { wakes.push(event) },
  })

  await controller.load()
  await Promise.resolve()

  expect(wakes).toEqual([{ alert: fired, price: 421, priceAgeMs: 0 }])
  controller.destroy()
})

test("a live crossing wakes the owning chat without becoming a price alert", async () => {
  let resolveWake!: (event: MarketMonitorTriggerEvent) => void
  const wake = new Promise<MarketMonitorTriggerEvent>((resolve) => { resolveWake = resolve })
  const controller = new MarketMonitorController({
    store: memoryStore([monitor()]),
    onTrigger: async (event) => { resolveWake(event) },
    now: () => NOW,
  })
  await controller.load()

  controller.applyQuote({ symbol: "F_ASELS0826", lastPrice: 400, sessionStatus: null, timestamp: NOW })
  controller.applyQuote({ symbol: "F_ASELS0826", lastPrice: 421, sessionStatus: null, timestamp: NOW })
  const event = await wake

  expect(event.alert.chatSessionId).toBe("chat-1")
  expect(event.alert.triggerId).toEqual(expect.any(String))
  controller.destroy()
})

test("reports monitor changes so the quote subscription can be refreshed", async () => {
  let changes = 0
  const controller = new MarketMonitorController({
    store: memoryStore([]),
    onTrigger: async () => {},
    onChange: () => { changes += 1 },
  })

  await controller.load()
  const saved = await controller.save(monitor())
  await controller.remove(saved.id)

  expect(changes).toBe(3)
  controller.destroy()
})
