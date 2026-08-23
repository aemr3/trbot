import { Impit } from "impit"
import { z } from "zod"

/**
 * HTTP access to the market data feed.
 *
 * The feed sits behind a bot-protection edge which checks both the TLS/HTTP2
 * handshake and the request headers. Native Bun requests are distinguishable
 * from a browser, but adding browser headers to that handshake is challenged as
 * an inconsistent identity. This transport therefore uses a coherent Chrome
 * handshake and header profile for every feed request.
 *
 * See docs/fintables-api/README.md for the measurements behind that.
 */

export interface FeedRequest {
  url: string
  method?: "GET" | "POST"
  token?: string
  body?: FeedRequestBody
  signal?: AbortSignal
}

/** The feed only ever receives credential and refresh payloads. */
export type FeedRequestBody =
  | { email: string; password: string }
  | { refresh: string }

export interface FeedResponse {
  status: number
  body: string
}

export interface FeedTransport {
  request(request: FeedRequest): Promise<FeedResponse>
}

/** The edge served a bot challenge instead of the API. Retryable, not an auth failure. */
export class FeedChallengeError extends Error {
  constructor(readonly url: string) {
    super(`Market data request was challenged by the upstream edge: ${url}`)
    this.name = "FeedChallengeError"
  }
}

/** The feed rejected the token. The caller should mint a new one, not retry as-is. */
export class FeedUnauthorizedError extends Error {
  constructor(readonly url: string, readonly detail: string | null) {
    super(`Market data request was rejected as unauthorized: ${url}${detail ? ` (${detail})` : ""}`)
    this.name = "FeedUnauthorizedError"
  }
}

export class FeedRequestError extends Error {
  constructor(readonly url: string, readonly status: number, readonly body: string) {
    super(`Market data request failed with HTTP ${status}: ${url}`)
    this.name = "FeedRequestError"
  }
}

/** The response was not the JSON the endpoint promises. */
export class FeedResponseError extends Error {
  constructor(readonly url: string, readonly detail: string) {
    super(`Market data response did not match its contract: ${url} (${detail})`)
    this.name = "FeedResponseError"
  }
}

/**
 * Recognizes the edge's interstitial. It answers with HTML and a 403, so without
 * this check a challenge reads as a permission problem and sends the caller
 * looking for a credential that was never wrong.
 */
export function isChallengeBody(body: string): boolean {
  return body.includes("Just a moment") || body.includes("__cf_chl") || body.includes("cf_chl_opt")
}

// One client shares its connection pool across every feed source. Impit's
// patched TLS and HTTP2 stacks reproduce the selected browser handshake and
// matching headers; Bun's native fetch cannot control the complete fingerprint.
const feedHttpClient = new Impit({
  browser: "chrome",
  vanillaFallback: false,
})

// The feed reports failures in-band as well as by status code.
const ErrorBodySchema = z.object({ errmsg: z.string() })

function errorMessage(body: string): string | null {
  return parseBody(body, ErrorBodySchema)?.errmsg ?? null
}

/** The body as `schema` describes it, or null when it is neither JSON nor a match. */
function parseBody<T>(body: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(body))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class FetchFeedTransport implements FeedTransport {
  async request(request: FeedRequest): Promise<FeedResponse> {
    const headers: Record<string, string> = {}
    if (request.token) headers.Authorization = `Bearer ${request.token}`
    if (request.body !== undefined) headers["Content-Type"] = "application/json"

    const response = await feedHttpClient.fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    })

    return { status: response.status, body: await response.text() }
  }
}

/** How long to wait between attempts when the edge serves a challenge. */
const CHALLENGE_RETRY_DELAYS_MS = [250, 1_000]

/**
 * Performs a request and validates the response against `schema`, turning the
 * feed's failure modes into distinct errors so a caller can tell a challenge
 * from a stale licence from a genuine outage.
 *
 * A challenge is retried, briefly. It is the one failure here that is neither
 * the caller's fault nor a lasting condition: the edge decided to interrogate a
 * request that an identical one moments later usually passes. Everything else
 * surfaces immediately, because retrying a rejected licence or a bad symbol only
 * adds load.
 */
export async function readJson<T>(
  transport: FeedTransport,
  request: FeedRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  for (const delay of CHALLENGE_RETRY_DELAYS_MS) {
    const attempt = await transport.request(request)
    if (!isChallengeBody(attempt.body)) return finish(attempt, request, schema)
    if (request.signal?.aborted) throw new FeedChallengeError(request.url)
    await Bun.sleep(delay)
  }
  return finish(await transport.request(request), request, schema)
}

function finish<T>(response: FeedResponse, request: FeedRequest, schema: z.ZodType<T>): T {
  if (isChallengeBody(response.body)) throw new FeedChallengeError(request.url)
  if (response.status === 401 || response.status === 403) {
    throw new FeedUnauthorizedError(request.url, errorMessage(response.body))
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FeedRequestError(request.url, response.status, response.body.slice(0, 400))
  }

  const parsed = parseBody(response.body, schema)
  if (parsed === null) throw new FeedResponseError(request.url, response.body.slice(0, 200))
  return parsed
}

/**
 * Builds a request URL. An undefined parameter is left off entirely, since for
 * several endpoints omitting one is how the default is asked for.
 */
export function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(`${base.replace(/\/+$/, "")}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}
