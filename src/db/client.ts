import { Database } from "bun:sqlite"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema.ts"

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
  sqlite.run("PRAGMA foreign_keys = ON")
  if (databasePath !== ":memory:") sqlite.run("PRAGMA journal_mode = WAL")

  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") })

  if (databasePath !== ":memory:") await chmod(databasePath, 0o600)

  return {
    db,
    close: () => sqlite.close(),
  }
}

function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl
  if (databaseUrl.startsWith("file:")) {
    return resolve(process.cwd(), databaseUrl.slice("file:".length))
  }
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl)
}
