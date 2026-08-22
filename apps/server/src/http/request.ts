import { ProtocolError, statusForErrorCode, type ProtocolErrorBody } from "@trbot/protocol/error.ts"
import { toProtocolError } from "../errors.ts"
import { z } from "zod"

const JsonObjectSchema = z.record(z.string(), z.json())
export type JsonObject = z.output<typeof JsonObjectSchema>

export function json<T>(value: T, status = 200): Response {
  return Response.json(value, { status })
}

export function errorResponse(cause: unknown): Response {
  const protocolError = toProtocolError(cause)
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
export async function readJsonObjectOrEmpty(request: Request): Promise<JsonObject | null> {
  const raw = await request.text()
  if (raw.trim().length === 0) return null
  let decoded: z.input<typeof JsonObjectSchema>
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new ProtocolError("invalid_request", "Expected a JSON body")
  }
  const parsed = JsonObjectSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new ProtocolError("invalid_request", "Expected a JSON object")
  }
  return parsed.data
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  let decoded: z.input<typeof JsonObjectSchema>
  try {
    decoded = await request.json()
  } catch {
    throw new ProtocolError("invalid_request", "Expected a JSON body")
  }
  const parsed = JsonObjectSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new ProtocolError("invalid_request", "Expected a JSON object")
  }
  return parsed.data
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
