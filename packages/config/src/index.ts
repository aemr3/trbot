import { isAbsolute, resolve } from "node:path"
import { environment, workspaceRoot } from "./workspace.ts"

export { parseEnvFile, workspaceRoot } from "./workspace.ts"

export interface AppCredentials {
  username: string
  password: string
}

export interface AppConfig {
  databaseUrl: string
  credentials: AppCredentials | null
  aiModel: string
  aiReasoningEffort: string
}

const DEFAULT_DATABASE_URL = "./data/db.sqlite"
const DEFAULT_AI_MODEL = "gpt-5.6-sol"
const DEFAULT_AI_REASONING_EFFORT = "high"

export function loadConfig(env: Record<string, string | undefined> = environment()): AppConfig {
  return {
    databaseUrl: loadDatabaseUrl(env),
    credentials: loadCredentials(env),
    aiModel: loadAiModel(env),
    aiReasoningEffort: loadAiReasoningEffort(env),
  }
}

// The model behind the AI market overview and the effort hint sent with it.
export function loadAiModel(env: Record<string, string | undefined> = environment()): string {
  return env.TRBOT_AI_MODEL?.trim() || DEFAULT_AI_MODEL
}

export function loadAiReasoningEffort(env: Record<string, string | undefined> = environment()): string {
  return env.TRBOT_AI_REASONING?.trim() || DEFAULT_AI_REASONING_EFFORT
}

/**
 * The database location, always absolute. A relative setting is anchored to the
 * workspace root, so every app opens the same database no matter which
 * directory it was started from.
 */
export function loadDatabaseUrl(env: Record<string, string | undefined> = environment()): string {
  return resolveDatabaseUrl(env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL)
}

function resolveDatabaseUrl(value: string): string {
  if (value === ":memory:") return value
  const path = value.startsWith("file:") ? value.slice("file:".length) : value
  return isAbsolute(path) ? path : resolve(workspaceRoot(), path)
}

// Optional credentials for unattended re-login. Kept in the environment (a
// gitignored .env), never in the database or source. When absent, the app
// falls back to the interactive login screen.
export function loadCredentials(env: Record<string, string | undefined> = environment()): AppCredentials | null {
  const username = env.TRBOT_USERNAME?.trim()
  const password = env.TRBOT_PASSWORD
  if (!username || !password) return null
  return { username, password }
}
