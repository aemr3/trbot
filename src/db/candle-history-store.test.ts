import { expect, test } from "bun:test"
import { openDatabase } from "./client.ts"
import { DrizzleCandleHistoryStore } from "./candle-history-store.ts"

test("upserts collected candles without overwriting other timestamps", async () => {
  const connection = await openDatabase(":memory:")
  const store = new DrizzleCandleHistoryStore(connection.db, () => 500)
  await store.put("future-1", "MIN_10", [
    { timestamp: 100, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { timestamp: 200, open: 11, high: 13, low: 10, close: 12, volume: 200 },
  ])
  await store.put("future-1", "MIN_10", [
    { timestamp: 200, open: 11, high: 14, low: 10, close: 13, volume: 300 },
  ])

  expect(await store.list("future-1", "MIN_10")).toEqual([
    { timestamp: 100, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { timestamp: 200, open: 11, high: 14, low: 10, close: 13, volume: 300 },
  ])
  connection.close()
})
