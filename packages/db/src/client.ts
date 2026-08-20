import { Database } from "bun:sqlite"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { z } from "zod"
import * as schema from "./schema.ts"

// Resolved against this module rather than the working directory so any
// workspace app can open the database from wherever it is started.
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../drizzle")

const SQLITE_STARTUP_RETRY_MS = 5_000
const SQLITE_MAX_RETRY_DELAY_MS = 250

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>

export interface DatabaseConnection {
  db: AppDatabase
  close(): void
}

export async function openDatabase(databaseUrl: string): Promise<DatabaseConnection> {
  const databasePath = resolveSqlitePath(databaseUrl)
  if (databasePath !== ":memory:") {
    const directory = dirname(databasePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }

  const sqlite = new Database(databasePath, { create: true })
  try {
    sqlite.run("PRAGMA foreign_keys = ON")
    if (databasePath !== ":memory:") {
      await retryWhileDatabaseIsBusy(() => sqlite.run("PRAGMA journal_mode = WAL"))
    }

    const db = drizzle(sqlite, { schema })
    await retryWhileDatabaseIsBusy(() => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }))

    if (databasePath !== ":memory:") await chmod(databasePath, 0o600)

    return {
      db,
      close: () => sqlite.close(),
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

async function retryWhileDatabaseIsBusy<T>(operation: () => T): Promise<T> {
  const deadline = Date.now() + SQLITE_STARTUP_RETRY_MS
  let delay = 25
  while (true) {
    try {
      return operation()
    } catch (error) {
      if (!isTransientDatabaseLock(error) || Date.now() >= deadline) throw error
      await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
      delay = Math.min(delay * 2, SQLITE_MAX_RETRY_DELAY_MS)
    }
  }
}

function isTransientDatabaseLock(cause: unknown): boolean {
  const parsed = z.object({ code: z.string() }).safeParse(cause)
  if (!parsed.success) return false
  const code = parsed.data.code
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")
}

// The location must already be resolved. `@trbot/config` anchors a relative
// setting to the workspace root, so silently resolving one here against the
// working directory would reintroduce the risk of two processes opening
// different databases from the same configuration.
function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl

  const path = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl
  if (!isAbsolute(path)) {
    throw new Error(
      `Database path must be absolute or ":memory:", received "${databaseUrl}". ` +
        "Resolve it with loadDatabaseUrl() from @trbot/config.",
    )
  }

  return path
}
