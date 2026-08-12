import { Database } from "bun:sqlite"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema.ts"

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
    await retryWhileDatabaseIsBusy(() => migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") }))

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

function isTransientDatabaseLock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = "code" in error && typeof error.code === "string" ? error.code : ""
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")
}

function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl
  if (databaseUrl.startsWith("file:")) {
    return resolve(process.cwd(), databaseUrl.slice("file:".length))
  }
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl)
}
