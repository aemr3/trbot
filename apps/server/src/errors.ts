import { ApiHttpError, AuthenticationError, OtpRequiredError, requiresAuthentication } from "@trbot/api"
import { isTransientStreamError } from "@trbot/api/transport.ts"
import { ProtocolError, type ProtocolErrorCode } from "@trbot/protocol/error.ts"

/**
 * Translates a provider failure into a protocol code. Clients never see
 * provider exception types, so every upstream failure is classified here once.
 */
export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error

  return new ProtocolError(classify(error), describe(error), { cause: error })
}

function classify(error: unknown): ProtocolErrorCode {
  if (error instanceof OtpRequiredError) return "otp_required"
  if (error instanceof AuthenticationError || requiresAuthentication(error)) return "unauthenticated"
  if (isTransientStreamError(error)) return "upstream_unavailable"
  if (error instanceof ApiHttpError) return "upstream_error"
  return "internal"
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
export function isDefiniteRefusal(error: unknown): boolean {
  const code = toProtocolError(error).code
  if (code === "unauthorized" || code === "unauthenticated" || code === "otp_required") return true
  if (code === "invalid_request" || code === "not_found" || code === "conflict") return true
  if (code !== "upstream_error") return false
  const status = providerStatus(error)
  return status !== null && status < 500
}

/** The HTTP status the provider answered with, wherever it sits in the chain. */
function providerStatus(error: unknown): number | null {
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const value = pending.shift()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (value instanceof ApiHttpError) return value.status
    const record = value as Record<string, unknown>
    for (const key of ["cause", "error", "errors"]) {
      const nested = record[key]
      if (Array.isArray(nested)) pending.push(...nested)
      else if (nested) pending.push(nested)
    }
  }
  return null
}
