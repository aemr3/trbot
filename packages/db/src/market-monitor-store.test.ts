import { afterEach, describe, expect, test } from "bun:test"
import { createMarketMonitor, type MarketMonitor } from "@trbot/market/market-monitor.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleMarketMonitorStore } from "./market-monitor-store.ts"
import { DrizzlePriceAlertStore } from "./price-alert-store.ts"

const NOW = 1_786_000_000_000

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

describe("DrizzleMarketMonitorStore", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("persists chat-owned monitors outside the price-alert store", async () => {
    connection = await openDatabase(":memory:")
    const monitors = new DrizzleMarketMonitorStore(connection.db)
    const alerts = new DrizzlePriceAlertStore(connection.db)
    const saved = monitor({ triggerId: "trigger-1" })

    await monitors.put(saved)

    expect(await monitors.list()).toEqual([saved])
    expect(await alerts.list()).toEqual([])

    await monitors.remove(saved.id)
    expect(await monitors.list()).toEqual([])
  })
})
