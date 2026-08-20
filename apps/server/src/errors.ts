import { ApiHttpError, AuthenticationError, OtpRequiredError, requiresAuthentication } from "@trbot/api"
import { isTransientStreamError } from "@trbot/api/transport.ts"
import { ProtocolError, type ProtocolErrorCode } from "@trbot/protocol/error.ts"

/**
 * Translates a provider failure into a protocol code. Clients never see
 * provider exception types, so every upstream failure is classified here once.
 */
export function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof ProtocolError) return cause

  return new ProtocolError(classify(cause), describe(cause), { cause })
}

function classify(cause: unknown): ProtocolErrorCode {
  if (cause instanceof OtpRequiredError) return "otp_required"
  if (cause instanceof AuthenticationError || requiresAuthentication(cause)) return "unauthenticated"
  if (isTransientStreamError(cause)) return "upstream_unavailable"
  if (cause instanceof ApiHttpError) return "upstream_error"
  return "internal"
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/**
 * Whether a failed call definitely did not take effect.
 *
 * This decides what happens to an idempotency key when a mutation fails. A
 * definite refusal frees it, so the trader can simply try again. Anything else
 * leaves the key in doubt: a dropped connection or a timeout is indistinguishable
 * from an order the provider accepted and then could not tell us about, and
 * running it again would place a second one.
 *
 * The rule is that the provider must have *answered*. A request rejected before
 * it left, or refused by the provider with a client error, did not happen. A
 * server error or a broken connection is unknown, and unknown is not "no".
 */
export function isDefiniteRefusal(cause: unknown): boolean {
  const code = toProtocolError(cause).code
  if (code === "unauthorized" || code === "unauthenticated" || code === "otp_required") return true
  if (code === "invalid_request" || code === "not_found" || code === "conflict") return true
  if (code !== "upstream_error") return false
  const status = providerStatus(cause)
  return status !== null && status < 500
}

/** The HTTP status the provider answered with, wherever it sits in the chain. */
function providerStatus(cause: unknown): number | null {
  const pending: unknown[] = [cause]
  const seen = new Set<Error>()
  while (pending.length > 0) {
    const value = pending.shift()
    if (!(value instanceof Error) || seen.has(value)) continue
    seen.add(value)
    if (value instanceof ApiHttpError) return value.status
    if (value.cause !== undefined) pending.push(value.cause)
    if (value instanceof AggregateError) pending.push(...value.errors)
  }
  return null
}
