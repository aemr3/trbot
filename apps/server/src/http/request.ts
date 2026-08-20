import type { OverviewStreamFrame } from "@trbot/protocol/ai.ts"
import { ProtocolError, statusForErrorCode, type ProtocolErrorBody } from "@trbot/protocol/error.ts"
import { toProtocolError } from "../errors.ts"

export function json<T>(value: T, status = 200): Response {
  return Response.json(value, { status })
}

/**
 * How often a stream with nothing to say says so.
 *
 * Well inside the connection's idle limit, because a socket that goes quiet for
 * longer than that limit is closed underneath the response.
 */
const HEARTBEAT_MS = 4_000

/**
 * A frame of a streamed response: a piece of the answer, a sign of life while
 * there is nothing to send yet, or the failure.
 */
export type StreamFrame = OverviewStreamFrame

/**
 * Streams newline-delimited JSON frames.
 *
 * A response that has already begun cannot change its status, so a failure part
 * way through arrives as an error frame instead. The client reads both the same
 * way and rethrows what it is given.
 *
 * Heartbeats are not decoration. A reasoning model can think for far longer than
 * the idle limit before its first token, and a silent socket is a closed socket:
 * the server drops the connection and the client can only report that the server
 * became unreachable. One goes out immediately, which also flushes the response
 * headers, so the client learns the request was accepted rather than waiting on
 * the first token to find out.
 */
export function ndjson(
  run: (emit: (frame: StreamFrame) => void) => Promise<void>,
  heartbeatMs = HEARTBEAT_MS,
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: StreamFrame): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
      }
      emit({ heartbeat: true })
      const heartbeat = setInterval(() => emit({ heartbeat: true }), heartbeatMs)
      try {
        await run(emit)
      } catch (error) {
        const protocolError = toProtocolError(error)
        clearInterval(heartbeat)
        emit({ error: { code: protocolError.code, message: protocolError.message } })
      } finally {
        clearInterval(heartbeat)
        controller.close()
      }
    },
  })
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
}

export function errorResponse(error: unknown): Response {
  const protocolError = toProtocolError(error)
  const body: ProtocolErrorBody = { error: { code: protocolError.code, message: protocolError.message } }
  return Response.json(body, { status: statusForErrorCode(protocolError.code) })
}

/** Compares secrets without leaking their length or contents through timing. */
export function secretsMatch(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  if (a.byteLength !== b.byteLength) return false
  return crypto.timingSafeEqual(a, b)
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const [scheme, value] = header.split(" ")
  return scheme?.toLowerCase() === "bearer" && value ? value : null
}

/**
 * A body that may not be there at all.
 *
 * For requests where sending nothing is meaningful — starting a chat session on the
 * current default rather than a named model — so an absent body is not an error.
 */
export async function readJsonObjectOrEmpty(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text()
  if (raw.trim().length === 0) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new ProtocolError("invalid_request", "Expected a JSON body")
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ProtocolError("invalid_request", "Expected a JSON object")
  }
  return decoded as Record<string, unknown>
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let decoded: unknown
  try {
    decoded = await request.json()
  } catch {
    throw new ProtocolError("invalid_request", "Expected a JSON body")
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ProtocolError("invalid_request", "Expected a JSON object")
  }
  return decoded as Record<string, unknown>
}

/**
 * Rejects repeated failures against the sign-in routes. Guessing a password or a
 * verification code over a network should not be cheap.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): void {
    const entry = this.attempts.get(key)
    if (entry && entry.resetAt > this.now() && entry.count >= this.limit) {
      throw new ProtocolError("invalid_request", "Too many attempts; wait a minute and try again")
    }
  }

  record(key: string): void {
    const now = this.now()
    const entry = this.attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    entry.count += 1
  }

  clear(key: string): void {
    this.attempts.delete(key)
  }
}
