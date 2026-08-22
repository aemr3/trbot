/**
 * The trading hours the feed states per symbol.
 *
 * Session strings look like `0955-1810` for equities, `0920-1810,1900-2300` for
 * an index future that trades an evening session too, and `24x7` for FX and
 * crypto. They are wall-clock times on the exchange's own calendar.
 *
 * This exists so an empty order book can be reported as a closed market rather
 * than a missing one. Outside session hours the feed sends a full book with every
 * level null, which is the exchange saying there are no resting orders — not that
 * the symbol has no book.
 */

import { MARKET_TIME_ZONE } from "@trbot/market/calendar.ts"

export { MARKET_TIME_ZONE }

export interface SessionWindow {
  /** Minutes from midnight, inclusive. */
  openMinute: number
  /** Minutes from midnight, exclusive. */
  closeMinute: number
}

const ALWAYS_OPEN = "24x7"

const WINDOW = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/

/**
 * Parses a session string into its windows.
 *
 * Returns null when the string is `24x7` (always open) or unparsable — the
 * caller cannot distinguish those from the windows alone, so `isMarketOpen`
 * handles both by treating the market as open rather than falsely reporting a
 * close.
 */
export function parseSessionWindows(session: string | null): SessionWindow[] | null {
  if (!session) return null
  const trimmed = session.trim()
  if (trimmed === ALWAYS_OPEN) return null

  const windows: SessionWindow[] = []
  for (const part of trimmed.split(",")) {
    const match = WINDOW.exec(part.trim())
    if (!match) continue
    const [, openHour, openMinute, closeHour, closeMinute] = match
    const open = Number(openHour) * 60 + Number(openMinute)
    const close = Number(closeHour) * 60 + Number(closeMinute)
    if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) continue
    windows.push({ openMinute: open, closeMinute: close })
  }
  return windows.length > 0 ? windows : null
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: MARKET_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
})

// `en-CA` is the locale that spells a date the way every date-keyed feed
// endpoint expects it: `2026-08-21`.
const CALENDAR = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/**
 * The exchange's own calendar day at `at`, as `YYYY-MM-DD`.
 *
 * Broker readings are addressed by trading day, and the day that matters is the
 * exchange's: a request sent at 00:30 in Istanbul is a request about the day
 * that has just begun there, whatever the local clock says.
 */
export function marketDate(at: number): string {
  return CALENDAR.format(new Date(at))
}

/** The calendar day before `date`, which is not necessarily a trading day. */
export function previousDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed)) return date
  return new Date(parsed - 86_400_000).toISOString().slice(0, 10)
}

interface MarketClock {
  minuteOfDay: number
  weekend: boolean
}

/** The exchange's wall clock, which is what a session string is expressed in. */
export function marketClock(at: number): MarketClock {
  const parts = CLOCK.formatToParts(new Date(at))
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
  const hour = Number(read("hour"))
  const minute = Number(read("minute"))
  const weekday = read("weekday")
  return {
    minuteOfDay: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    weekend: weekday === "Sat" || weekday === "Sun",
  }
}

/**
 * Whether `session` is trading at `at`.
 *
 * An unknown or always-open session counts as open: reporting a market closed on
 * a session string this does not understand would hide a live book, which is the
 * more damaging mistake of the two.
 */
export function isMarketOpen(session: string | null, at: number): boolean {
  const windows = parseSessionWindows(session)
  if (!windows) return true

  const clock = marketClock(at)
  // Every windowed session here is an exchange session, and none of them trade
  // at the weekend.
  if (clock.weekend) return false
  return windows.some((window) => clock.minuteOfDay >= window.openMinute && clock.minuteOfDay < window.closeMinute)
}

/**
 * Session state codes the feed sends on the `d` field.
 *
 * These two are the whole vocabulary the vendor's own client understands: it
 * defines `{SUREKLI_ISLEM: 2, DEVRE_KESICI: 13}` and uses it for exactly one
 * thing, a circuit-breaker badge testing `=== 13`. Other values do occur — 26 on
 * equities and 38 on futures, both after the close — and nothing in the vendor's
 * client interprets them, so neither does this.
 */
export const SESSION_STATE_CODES = {
  /** Continuous trading. */
  continuous: 2,
  /** Devre kesici: trading halted by a circuit breaker. */
  circuitBreaker: 13,
} as const

/** The status the application reads, or null when nothing is known. */
export type MarketSessionStatus = "OPEN" | "CLOSED" | "CIRCUIT_BREAKER"

/**
 * The session status for a symbol.
 *
 * Open and closed come from the exchange's published trading hours rather than
 * from `code`, because the codes are not documented and only two of them have a
 * known meaning. A circuit breaker is reported when the feed says so, since that
 * is a halt the clock cannot show.
 */
export function sessionStatus(session: string | null, code: number | null, at: number): MarketSessionStatus | null {
  if (code === SESSION_STATE_CODES.circuitBreaker) return "CIRCUIT_BREAKER"
  const windows = parseSessionWindows(session)
  // A round-the-clock or unreadable session says nothing about being open, and
  // claiming otherwise would misreport it.
  if (!windows && session?.trim() !== "24x7") return null
  return isMarketOpen(session, at) ? "OPEN" : "CLOSED"
}
