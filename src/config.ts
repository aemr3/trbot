export interface AppConfig {
  databaseUrl: string
}

const DEFAULT_DATABASE_URL = "./data/db.sqlite"

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    databaseUrl: loadDatabaseUrl(env),
  }
}

export function loadDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL
}
