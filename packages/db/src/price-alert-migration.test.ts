import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"

test("removes obsolete alert continuation columns after monitors move to their own table", async () => {
  const database = new Database(":memory:")
  try {
    database.run(`
      CREATE TABLE price_alerts (
        id text PRIMARY KEY NOT NULL,
        symbol text NOT NULL,
        chat_session_id text,
        on_trigger text
      )
    `)
    database.run(`
      CREATE TABLE market_monitors (
        id text PRIMARY KEY NOT NULL,
        chat_session_id text NOT NULL,
        on_trigger text NOT NULL
      )
    `)
    database.run("INSERT INTO price_alerts VALUES ('alert-1', 'ASELS', NULL, NULL)")
    database.run("INSERT INTO market_monitors VALUES ('monitor-1', 'chat-1', 'Reassess the breakout')")

    const migration = await Bun.file(
      new URL("../drizzle/0050_remove_legacy_alert_continuation.sql", import.meta.url),
    ).text()
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.run(statement)
    }

    expect(database.query("SELECT id, symbol FROM price_alerts").get()).toEqual({
      id: "alert-1",
      symbol: "ASELS",
    })
    expect(database.query("SELECT * FROM market_monitors").get()).toEqual({
      id: "monitor-1",
      chat_session_id: "chat-1",
      on_trigger: "Reassess the breakout",
    })
    const columns = z.array(z.object({ name: z.string() })).parse(database.query("PRAGMA table_info(price_alerts)").all())
    expect(columns.map((column) => column.name)).toEqual(["id", "symbol"])
  } finally {
    database.close()
  }
})
