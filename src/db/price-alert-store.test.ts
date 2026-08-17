import { afterEach, describe, expect, test } from "bun:test"
import { createPriceAlert, type PriceAlert } from "../market/alert.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzlePriceAlertStore } from "./price-alert-store.ts"

const NOW = 1_786_000_000_000

function alert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    ...createPriceAlert(
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
    ),
    ...overrides,
  }
}

describe("price alert store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("round-trips an alert, including the trail's extreme and what it fired at", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzlePriceAlertStore(connection.db)
    const trailing = alert({
      id: "alert-2",
      direction: "BELOW",
      kind: "TRAILING_ATR",
      value: 2,
      interval: "MIN_10",
      extremePrice: 430,
      triggerPrice: 422,
      atrValue: 4,
    })

    expect(await store.list()).toEqual([])
    await store.put(alert())
    await store.put(trailing)
    expect(await store.list()).toEqual([alert(), trailing])

    // Firing replaces the row rather than adding one, and the price it saw
    // survives the restart with it.
    const fired = { ...trailing, status: "TRIGGERED" as const, triggeredAt: NOW + 1_000, triggeredPrice: 421 }
    await store.put(fired)
    expect(await store.list()).toEqual([alert(), fired])

    await store.remove("alert-1")
    expect(await store.list()).toEqual([fired])
  })

  test("skips a row whose enums no longer parse", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzlePriceAlertStore(connection.db)
    await store.put(alert())
    await store.put(alert({ id: "alert-2" }))
    connection.db.$client.run("UPDATE price_alerts SET direction = 'SIDEWAYS' WHERE id = 'alert-1'")

    const listed = await store.list()
    expect(listed.map((entry) => entry.id)).toEqual(["alert-2"])
  })
})
