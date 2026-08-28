import { readFileSync } from "node:fs"
import { HttpClient, type HttpClientOptions } from "@trbot/client/http.ts"
import { StreamConnection, type StreamConnectionOptions } from "@trbot/client/stream.ts"
import type { ClientTlsOptions } from "@trbot/client/tls.ts"
import type { ClientConfig, ClientTls } from "@trbot/config"
import { ROUTES, SessionStateSchema } from "@trbot/protocol/routes.ts"

/**
 * The terminal's link to the server: one HTTP client for requests and one socket
 * for streams. This is the only way the terminal reaches market data — it has no
 * path to the provider.
 */
export interface ServerSession {
  /** Where the server is, for messages that need to name it. */
  url: string
  http: HttpClient
  stream: StreamConnection
  /**
   * Reports the first failure of a stream outage. The application sets this
   * rather than passing it in, because the session is opened before there is
   * anywhere to report to.
   */
  onStreamError(listener: (cause: unknown) => void): void
  close(): void
}

export interface ServerSessionOptions {
  config: ClientConfig
  /** PEM material overriding the paths in `config.tls`. */
  tls?: ClientTlsOptions | null
  transports?: ServerSessionTransports
}

export interface ServerSessionTransports {
  http(options: HttpClientOptions): HttpClient
  stream(options: StreamConnectionOptions): StreamConnection
}

const defaultTransports: ServerSessionTransports = {
  http: (options) => new HttpClient(options),
  stream: (options) => new StreamConnection(options),
}

export function createServerSession(options: ServerSessionOptions): ServerSession {
  // HTTP and WebSocket establish separate TLS connections, so both need the
  // client identity as well as the authority that verifies the server.
  const tls = options.tls === undefined ? readClientTls(options.config.tls) : options.tls
  const transports = options.transports ?? defaultTransports
  const clientId = crypto.randomUUID()
  const http = transports.http({
    url: options.config.url,
    token: options.config.token,
    clientId,
    tls,
  })
  let report: ((cause: unknown) => void) | null = null
  const stream = transports.stream({
    url: options.config.url,
    token: options.config.token,
    clientId,
    tls,
    onError: (error) => report?.(error),
  })

  return {
    url: options.config.url,
    http,
    stream,
    onStreamError(listener: (cause: unknown) => void): void {
      report = listener
    },
    close(): void {
      report = null
      stream.close()
    },
  }
}

/**
 * Reads the mTLS material `bun run server:cert` created. An unreadable file
 * fails here with its setting name rather than becoming a generic handshake
 * failure on every request and reconnect.
 */
function readClientTls(paths: ClientTls | null): ClientTlsOptions | null {
  if (!paths) return null
  const tls: ClientTlsOptions = {
    cert: readPem(paths.certPath, "TRBOT_CLIENT_TLS_CERT"),
    key: readPem(paths.keyPath, "TRBOT_CLIENT_TLS_KEY"),
  }
  if (paths.caPath) tls.ca = readPem(paths.caPath, "TRBOT_CLIENT_TLS_SERVER_CA")
  return tls
}

function readPem(path: string, setting: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${setting} names ${path}, which could not be read: ${message}`)
  }
}

/** Whether the server currently holds a usable provider session. */
export async function serverAuthenticated(http: HttpClient): Promise<boolean> {
  const state = await http.get(ROUTES.session, SessionStateSchema)
  return state.authenticated
}

/** Signs the server in. Throws a protocol error with `otp_required` when the provider asks for a code. */
export async function signIn(http: HttpClient, username: string, password: string): Promise<void> {
  await http.post(ROUTES.login, SessionStateSchema, { body: { username, password } })
}

export async function submitOtp(http: HttpClient, code: string): Promise<void> {
  await http.post(ROUTES.otp, SessionStateSchema, { body: { code } })
}
