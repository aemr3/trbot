import { ProtocolError, parseErrorBody } from "@trbot/protocol/error.ts"
import { IDEMPOTENCY_HEADER } from "@trbot/protocol/routes.ts"
import type { ZodType } from "zod"

export interface HttpClientOptions {
  url: string
  token: string
  /** Certificate authority to trust, for a server using a self-signed certificate. */
  ca?: string | null
  /** Request transport override for tests and embedded clients. */
  fetch?: HttpFetch
}

export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit & { tls?: { ca: string } },
) => Promise<Response>

export interface RequestOptions {
  query?: Record<string, string | undefined>
  body?: unknown
  signal?: AbortSignal
  /** Deduplicates a mutation so a retry cannot place a second order. */
  idempotencyKey?: string
}

/**
 * Talks to the trbot server. Every failure surfaces as a ProtocolError, so
 * callers read protocol codes rather than transport details.
 */
export class HttpClient {
  private readonly tls: { ca: string } | undefined
  private readonly fetch: HttpFetch

  constructor(private readonly options: HttpClientOptions) {
    this.tls = options.ca ? { ca: options.ca } : undefined
    this.fetch = options.fetch ?? fetch
  }

  get<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.send("GET", path, schema, options)
  }

  post<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.send("POST", path, schema, options)
  }

  put<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.send("PUT", path, schema, options)
  }

  patch<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.send("PATCH", path, schema, options)
  }

  delete<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
    return this.send("DELETE", path, schema, options)
  }

  /**
   * Posts and returns the response body unread, for a route that answers a
   * piece at a time. The status is still checked first, so a request the server
   * refuses fails the same way an ordinary one does.
   */
  async stream(path: string, options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request("POST", path, options)
    if (!response.body) throw new ProtocolError("internal", "The server sent an empty stream")
    return response.body
  }

  private async send<T>(method: string, path: string, schema: ZodType<T>, options: RequestOptions): Promise<T> {
    const response = await this.request(method, path, options)
    const body: unknown = await response.json().catch(() => {
      throw new ProtocolError("internal", `The server returned invalid JSON for ${method} ${path}`)
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new ProtocolError("internal", `The server returned an invalid response for ${method} ${path}`, {
        cause: parsed.error,
      })
    }
    return parsed.data
  }

  private async request(method: string, path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(this.options.url + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }

    const headers = new Headers({ Authorization: `Bearer ${this.options.token}` })
    if (options.body !== undefined) headers.set("Content-Type", "application/json")
    if (options.idempotencyKey) headers.set(IDEMPOTENCY_HEADER, options.idempotencyKey)

    let response: Response
    try {
      const tls = this.tls ? { tls: this.tls } : {}
      response = await this.fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        ...tls,
      })
    } catch (error) {
      // An aborted request is the caller's own doing, so it passes through
      // rather than being reported as the server being unreachable.
      if (isAbortError(error)) throw error
      throw new ProtocolError("upstream_unavailable", `Cannot reach the trbot server at ${this.options.url}`, {
        cause: error,
      })
    }

    if (response.ok) return response

    const body: unknown = await response.json().catch(() => null)
    throw parseErrorBody(body) ?? new ProtocolError("internal", `Server returned ${response.status}`)
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}

/** A fresh key per mutation attempt chain; a retry reuses it deliberately. */
export function idempotencyKey(): string {
  return crypto.randomUUID()
}
