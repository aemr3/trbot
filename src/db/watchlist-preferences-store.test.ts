import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_WATCHLIST_PREFERENCES } from "../screens/watchlist-preferences.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleWatchlistPreferencesStore } from "./watchlist-preferences-store.ts"

describe("watchlist preferences store", () => {
  let connection: DatabaseConnection | null = null
  let temporaryDirectory: string | null = null

  afterEach(async () => {
    connection?.close()
    connection = null
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true })
    temporaryDirectory = null
  })

  test("returns defaults and restores the latest display choices after reopening", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "trbot-preferences-"))
    const databasePath = join(temporaryDirectory, "preferences.db")
    connection = await openDatabase(databasePath)
    const store = new DrizzleWatchlistPreferencesStore(connection.db)

    expect(store.get()).toEqual(DEFAULT_WATCHLIST_PREFERENCES)

    store.put({
      instrumentSort: "change",
      sortDirection: "asc",
      candleRange: "WEEK",
      candleInterval: "MIN_15",
      chartTarget: "INSTRUMENT",
      chartIndicators: ["EMA_20", "VWAP"],
      selectedInstrumentUid: "future-2",
      orderKind: "MARKETABLE_LIMIT",
    })
    connection.close()
    connection = null
    connection = await openDatabase(databasePath)

    expect(new DrizzleWatchlistPreferencesStore(connection.db).get()).toEqual({
      instrumentSort: "change",
      sortDirection: "asc",
      candleRange: "WEEK",
      candleInterval: "MIN_15",
      chartTarget: "INSTRUMENT",
      chartIndicators: ["EMA_20", "VWAP"],
      selectedInstrumentUid: "future-2",
      orderKind: "MARKETABLE_LIMIT",
    })
  })
})
