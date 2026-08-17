import { afterEach, describe, expect, test } from "bun:test"
import { createStopRule, type StopRule } from "@trbot/trading/stop.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleStopRuleStore } from "./stop-rule-store.ts"

const NOW = 1_786_000_000_000

function rule(overrides: Partial<StopRule> = {}): StopRule {
  return {
    ...createStopRule(
      {
        id: "rule-1",
        instrumentUid: "instrument-1",
        symbol: "ASELS",
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
    ),
    ...overrides,
  }
}

describe("stop rule store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("round-trips a rule, including the trail's high-water mark", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleStopRuleStore(connection.db)
    const trailing = rule({
      id: "rule-2",
      kind: "TRAILING_ATR",
      value: 2,
      interval: "MIN_15",
      quantity: 3,
      extremePrice: 420,
      triggerPrice: 412,
      atrValue: 4,
    })

    expect(await store.list()).toEqual([])
    await store.put(rule())
    await store.put(trailing)
    expect(await store.list()).toEqual([rule(), trailing])

    // Advancing the trail replaces the row rather than adding one.
    const advanced = { ...trailing, extremePrice: 430, triggerPrice: 422, updatedAt: NOW + 1_000 }
    await store.put(advanced)
    expect(await store.list()).toEqual([rule(), advanced])

    await store.remove("rule-1")
    expect(await store.list()).toEqual([advanced])
  })

  test("skips a row whose enums no longer parse", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleStopRuleStore(connection.db)
    await store.put(rule())
    await store.put(rule({ id: "rule-2" }))
    connection.db.$client.run("UPDATE stop_rules SET kind = 'PARABOLIC' WHERE id = 'rule-1'")

    const listed = await store.list()
    expect(listed.map((entry) => entry.id)).toEqual(["rule-2"])
  })
})
