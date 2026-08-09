export interface AppCredentials {
  username: string
  password: string
}

export interface AppConfig {
  databaseUrl: string
  credentials: AppCredentials | null
}

const DEFAULT_DATABASE_URL = "./data/db.sqlite"

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    databaseUrl: loadDatabaseUrl(env),
    credentials: loadCredentials(env),
  }
}

export function loadDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL
}

// Optional credentials for unattended re-login. Kept in the environment (a
// gitignored .env), never in the database or source. When absent, the app
// falls back to the interactive login screen.
export function loadCredentials(env: Record<string, string | undefined> = process.env): AppCredentials | null {
  const username = env.TRBOT_USERNAME?.trim()
  const password = env.TRBOT_PASSWORD
  if (!username || !password) return null
  return { username, password }
}
