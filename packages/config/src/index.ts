import { dirname, isAbsolute, resolve } from "node:path"
import { environment, workspaceRoot } from "./workspace.ts"

export { parseEnvFile, workspaceRoot } from "./workspace.ts"

export interface AppCredentials {
  username: string
  password: string
}

export interface AppConfig {
  databaseUrl: string
  credentials: AppCredentials | null
  feedCredentials: AppCredentials | null
  /** Server-only token issued by BotFather; null leaves mobile chat disabled. */
  telegramBotToken: string | null
}

const DEFAULT_DATABASE_URL = "./data/db.sqlite"
const DEFAULT_SERVER_HOST = "127.0.0.1"
const DEFAULT_SERVER_PORT = 7717
const DEFAULT_SERVER_URL = `http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`
const DEFAULT_TLS_DIRECTORY = "data/tls"

/** The placeholder shipped in .env.example. The server refuses to run with it. */
export const EXAMPLE_SERVER_TOKEN = "example-token-replace-before-use"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"])

interface ServerTls {
  certPath: string
  keyPath: string
  clientCaPath: string
}

export interface ServerConfig {
  host: string
  port: number
  token: string
  tls: ServerTls | null
}

export interface ClientTls {
  caPath: string | null
  certPath: string
  keyPath: string
}

export interface ClientConfig {
  url: string
  token: string
  tls: ClientTls | null
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function loadConfig(env: Record<string, string | undefined> = environment()): AppConfig {
  return {
    databaseUrl: loadDatabaseUrl(env),
    credentials: loadCredentials(env),
    feedCredentials: loadFeedCredentials(env),
    telegramBotToken: env.TRBOT_TELEGRAM_BOT_TOKEN?.trim() || null,
  }
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

function resolveOptionalPath(value: string | undefined): string | null {
  if (!value) return null
  return isAbsolute(value) ? value : resolve(workspaceRoot(), value)
}

function defaultTlsPath(filename: string): string {
  return resolve(workspaceRoot(), DEFAULT_TLS_DIRECTORY, filename)
}

/**
 * How the server binds and authenticates callers.
 *
 * A non-loopback bind uses the conventional mTLS bundle automatically, so this
 * API cannot become plaintext across a network by omitting path settings.
 * Loopback stays plain HTTP unless TLS paths are explicitly configured.
 */
export function loadServerConfig(env: Record<string, string | undefined> = environment()): ServerConfig {
  const host = env.TRBOT_SERVER_HOST?.trim() || DEFAULT_SERVER_HOST
  const port = parsePort(env.TRBOT_SERVER_PORT)
  const token = env.TRBOT_SERVER_TOKEN?.trim() ?? ""
  const configuredCertPath = resolveOptionalPath(env.TRBOT_SERVER_TLS_CERT?.trim())
  const configuredKeyPath = resolveOptionalPath(env.TRBOT_SERVER_TLS_KEY?.trim())
  const configuredClientCaPath = resolveOptionalPath(env.TRBOT_SERVER_TLS_CLIENT_CA?.trim())
  if (Boolean(configuredCertPath) !== Boolean(configuredKeyPath)) {
    throw new Error("TRBOT_SERVER_TLS_CERT and TRBOT_SERVER_TLS_KEY must be set together")
  }

  const useTls = !isLoopbackHost(host) || configuredCertPath !== null || configuredClientCaPath !== null
  const certPath = configuredCertPath ?? (useTls ? defaultTlsPath("server.crt") : null)
  const keyPath = configuredKeyPath ?? (useTls ? defaultTlsPath("server.key") : null)
  const clientCaPath = configuredClientCaPath ?? (certPath ? resolve(dirname(certPath), "ca.crt") : null)
  const tls = certPath && keyPath && clientCaPath ? { certPath, keyPath, clientCaPath } : null

  if (!token) {
    throw new Error("TRBOT_SERVER_TOKEN is required. Generate one with: bun run server:token")
  }
  if (token === EXAMPLE_SERVER_TOKEN) {
    throw new Error("TRBOT_SERVER_TOKEN still holds the example value. Generate one with: bun run server:token")
  }
  return { host, port, token, tls }
}

/** How a client reaches the server. */
export function loadClientConfig(env: Record<string, string | undefined> = environment()): ClientConfig {
  const token = env.TRBOT_SERVER_TOKEN?.trim() ?? ""
  if (!token) throw new Error("TRBOT_SERVER_TOKEN is required to reach the server")

  const url = (env.TRBOT_SERVER_URL?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, "")
  const configuredCaPath = resolveOptionalPath(env.TRBOT_CLIENT_TLS_SERVER_CA?.trim())
  const configuredCertPath = resolveOptionalPath(env.TRBOT_CLIENT_TLS_CERT?.trim())
  const configuredKeyPath = resolveOptionalPath(env.TRBOT_CLIENT_TLS_KEY?.trim())
  if (Boolean(configuredCertPath) !== Boolean(configuredKeyPath)) {
    throw new Error("TRBOT_CLIENT_TLS_CERT and TRBOT_CLIENT_TLS_KEY must be set together")
  }

  const useDefaultBundle = url.toLowerCase().startsWith("https://") && configuredCertPath === null
  const caPath = configuredCaPath ?? (useDefaultBundle ? defaultTlsPath("ca.crt") : null)
  const certPath = configuredCertPath ?? (caPath ? resolve(dirname(caPath), "client.crt") : null)
  const keyPath = configuredKeyPath ?? (caPath ? resolve(dirname(caPath), "client.key") : null)

  return {
    url,
    token,
    tls: certPath && keyPath ? { caPath, certPath, keyPath } : null,
  }
}

function parsePort(value: string | undefined): number {
  const port = Number(value?.trim() || DEFAULT_SERVER_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TRBOT_SERVER_PORT must be a port number, received "${value}"`)
  }
  return port
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

/**
 * Credentials for the market data feed, which is a separate account from the
 * brokerage: the feed serves prices, the brokerage places orders. The variable
 * names say whose account it is, which is the one place the vendor belongs.
 */
export function loadFeedCredentials(env: Record<string, string | undefined> = environment()): AppCredentials | null {
  const username = env.FINTABLES_USERNAME?.trim()
  const password = env.FINTABLES_PASSWORD
  if (!username || !password) return null
  return { username, password }
}
