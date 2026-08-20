import { z } from "zod"

/**
 * Failure kinds a client can act on. These replace the provider error helpers a
 * client used to read directly: a client sees protocol codes, never provider
 * exceptions.
 */
const PROTOCOL_ERROR_CODES = [
  // The caller's server token is missing or wrong.
  "unauthorized",
  // The server has no usable provider session; the client should sign in.
  "unauthenticated",
  // Provider login needs the SMS verification code.
  "otp_required",
  "invalid_request",
  "not_found",
  // The same idempotency key arrived with a different request body.
  "conflict",
  // An earlier attempt under this idempotency key never reported an outcome, so
  // whether it took effect is unknown. Retrying it could repeat it.
  "outcome_unknown",
  // The provider is reachable but refused the call.
  "upstream_error",
  // A transient upstream condition; retrying is reasonable.
  "upstream_unavailable",
  "internal",
] as const

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number]

export interface ProtocolErrorBody {
  error: {
    code: ProtocolErrorCode
    message: string
  }
}

export const ProtocolErrorBodySchema: z.ZodType<ProtocolErrorBody> = z.object({
  error: z.object({
    code: z.enum(PROTOCOL_ERROR_CODES),
    message: z.string(),
  }),
})

const ProtocolErrorPayloadSchema = z.object({
  error: z.object({
    code: z.enum(PROTOCOL_ERROR_CODES),
    message: z.string().optional(),
  }),
})
const ProtocolErrorPayloadInputSchema = z.preprocess((value) => value, ProtocolErrorPayloadSchema)

const STATUS_BY_CODE = {
  unauthorized: 401,
  unauthenticated: 419,
  otp_required: 409,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  outcome_unknown: 409,
  upstream_error: 502,
  upstream_unavailable: 503,
  internal: 500,
} satisfies Record<ProtocolErrorCode, number>

export function statusForErrorCode(code: ProtocolErrorCode): number {
  return STATUS_BY_CODE[code]
}

/** An error carrying a protocol code, thrown by clients and by route handlers. */
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = "ProtocolError"
  }
}

export function isProtocolError(cause: unknown): cause is ProtocolError {
  return cause instanceof ProtocolError
}

/** True when the server has no usable provider session and the client must sign in. */
export function requiresAuthentication(cause: unknown): boolean {
  return isProtocolError(cause) && (cause.code === "unauthenticated" || cause.code === "otp_required")
}

/** True when retrying is reasonable rather than surfacing a failure to the trader. */
export function isTransientError(cause: unknown): boolean {
  return isProtocolError(cause) && cause.code === "upstream_unavailable"
}

export function parseErrorBody(body: z.input<typeof ProtocolErrorPayloadInputSchema>): ProtocolError | null {
  const parsed = ProtocolErrorPayloadInputSchema.safeParse(body)
  if (!parsed.success) return null
  return new ProtocolError(parsed.data.error.code, parsed.data.error.message ?? parsed.data.error.code)
}
