import { z } from "zod"

/**
 * The exchange's own calendar.
 *
 * Weekly and monthly bars are cut on it rather than by dividing the timeline: a
 * month is 28 to 31 days and a week crosses daylight-saving changes, so no fixed
 * duration describes either. Anything that has to know whether such a bar has
 * finished compares calendar periods instead of adding a span to a timestamp.
 */

export const MARKET_TIME_ZONE = "Europe/Istanbul"

export const CALENDAR_PERIODS = ["week", "month"] as const
export type CalendarPeriod = (typeof CALENDAR_PERIODS)[number]
export const CalendarPeriodSchema = z.enum(CALENDAR_PERIODS)

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
})

interface DayParts {
  year: string
  month: string
  day: string
  weekday: string
}

function dayParts(timestamp: number): DayParts {
  const parts = PARTS.formatToParts(new Date(timestamp))
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
  return { year: read("year"), month: read("month"), day: read("day"), weekday: read("weekday") }
}

/** Exchange-local calendar date, used to keep session-derived values aligned. */
export function marketDayKey(timestamp: number): string {
  const parts = dayParts(timestamp)
  return `${parts.year}-${parts.month}-${parts.day}`
}

const WEEKDAY_INDEX = new Map([["Mon", 0], ["Tue", 1], ["Wed", 2], ["Thu", 3], ["Fri", 4], ["Sat", 5], ["Sun", 6]])

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The period a timestamp falls in, as a key that sorts in calendar order.
 *
 * A month is `2026-08` and a week is the date of its Monday, matching the
 * exchange convention. Sorting matters as much as equality: it is how a bar from
 * a finished period is told from the one still forming.
 */
export function calendarKey(timestamp: number, period: CalendarPeriod): string {
  const parts = dayParts(timestamp)
  if (period === "month") return `${parts.year}-${parts.month}`
  const offset = WEEKDAY_INDEX.get(parts.weekday) ?? 0
  const monday = dayParts(timestamp - offset * DAY_MS)
  return `${monday.year}-${monday.month}-${monday.day}`
}
