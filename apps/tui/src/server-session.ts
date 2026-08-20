import { readFileSync } from "node:fs"
import { HttpClient } from "@trbot/client/http.ts"
import { StreamConnection } from "@trbot/client/stream.ts"
import type { ClientConfig } from "@trbot/config"
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
  onStreamError(listener: (error: unknown) => void): void
  close(): void
}

export interface ServerSessionOptions {
  config: ClientConfig
  /** The authority itself, overriding the one `config.caPath` names. */
  ca?: string | null
}

export function createServerSession(options: ServerSessionOptions): ServerSession {
  // Both the requests and the socket need it: a remote server presents the same
  // self-signed certificate to each, and nothing else trusts that authority.
  const ca = options.ca ?? readAuthority(options.config.caPath)
  const http = new HttpClient({
    url: options.config.url,
    token: options.config.token,
    ca,
  })
  let report: ((error: unknown) => void) | null = null
  const stream = new StreamConnection({
    url: options.config.url,
    token: options.config.token,
    ca,
    onError: (error) => report?.(error),
  })

  return {
    url: options.config.url,
    http,
    stream,
    onStreamError(listener: (error: unknown) => void): void {
      report = listener
    },
    close(): void {
      report = null
      stream.close()
    },
  }
}

/**
 * Reads the authority `bun run server:cert` created, which `TRBOT_SERVER_CA`
 * names. An unreadable one fails here rather than as a certificate error on
 * every request afterwards.
 */
function readAuthority(path: string | null): string | null {
  if (!path) return null
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`TRBOT_SERVER_CA names ${path}, which could not be read: ${(error as Error).message}`)
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
