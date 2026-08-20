import { afterEach, describe, expect, test } from "bun:test"
import { buildOverviewDigest, type StoredOverviewSnapshot } from "@trbot/market/overview.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleOverviewSnapshotStore } from "./overview-snapshot-store.ts"

describe("overview snapshot store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("keeps one reading per instrument and horizon across runs", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleOverviewSnapshotStore(connection.db)
    const intraday = snapshot("INTRADAY", "Buyers lift the offer.")
    const daily = snapshot("DAILY", "Custody grew all week.")

    expect(await store.list()).toEqual([])
    await store.put(intraday)
    await store.put(daily)
    expect(await store.list()).toEqual([intraday, daily])

    // A rerun for the same horizon replaces its reading, not the other's.
    const rewritten = { ...intraday, commentary: "Sellers take control.", generatedAt: intraday.generatedAt + 60_000 }
    await store.put(rewritten)
    expect(await store.list()).toEqual([rewritten, daily])
  })

  test("skips rows whose digest no longer parses", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleOverviewSnapshotStore(connection.db)
    await store.put(snapshot("INTRADAY", "Readable."))
    connection.db.$client.run("UPDATE overview_snapshots SET digest = 'not json'")

    expect(await store.list()).toEqual([])
  })

  test("skips valid JSON that no longer has the digest shape", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleOverviewSnapshotStore(connection.db)
    await store.put(snapshot("DAILY", "Readable."))
    connection.db.$client.run(`UPDATE overview_snapshots SET digest = '{"mode":"DAILY"}'`)

    expect(await store.list()).toEqual([])
  })
})

function snapshot(mode: "INTRADAY" | "DAILY", commentary: string): StoredOverviewSnapshot {
  return {
    instrumentUid: "instrument-1",
    mode,
    digest: buildOverviewDigest({
      mode,
      instrument: { symbol: "ASELS", displayName: null, lastPrice: 390, contractSymbol: "F_ASELS0826", contractLastPrice: 394 },
      range: { start: null, end: null },
    }),
    commentary,
    generatedAt: 1_786_000_000_000,
  }
}
