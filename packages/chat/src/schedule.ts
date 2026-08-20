const MINUTE_MS = 60_000
const MAX_SEARCH_MINUTES = 60 * 24 * 366 * 8

interface CronField {
  wildcard: boolean
  values: ReadonlySet<number>
}

interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

/** Validates the five-field Vixie-cron subset accepted by scheduled chat tasks. */
export function isValidCronExpression(expression: string): boolean {
  return parseCron(expression) !== null
}

/** Finds the first matching local-time minute strictly after `after`. */
export function nextCronOccurrence(expression: string, after: number): number | null {
  const cron = parseCron(expression)
  if (!cron) return null
  const candidate = new Date(Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  candidate.setSeconds(0, 0)

  for (let checked = 0; checked < MAX_SEARCH_MINUTES; checked += 1) {
    const dayOfMonthMatches = cron.dayOfMonth.values.has(candidate.getDate())
    const dayOfWeekMatches = cron.dayOfWeek.values.has(candidate.getDay())
    const dayMatches = cron.dayOfMonth.wildcard
      ? dayOfWeekMatches
      : cron.dayOfWeek.wildcard
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches
    if (
      cron.minute.values.has(candidate.getMinutes()) &&
      cron.hour.values.has(candidate.getHours()) &&
      dayMatches &&
      cron.month.values.has(candidate.getMonth() + 1)
    ) return candidate.getTime()
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}

function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0] ?? "", 0, 59)
  const hour = parseField(fields[1] ?? "", 0, 23)
  const dayOfMonth = parseField(fields[2] ?? "", 1, 31)
  const month = parseField(fields[3] ?? "", 1, 12)
  const dayOfWeek = parseField(fields[4] ?? "", 0, 7, true)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function parseField(source: string, minimum: number, maximum: number, sundayAlias = false): CronField | null {
  const values = new Set<number>()
  const wildcard = source.startsWith("*")
  for (const part of source.split(",")) {
    if (!part) return null
    const [rangeText = "", stepText] = part.split("/")
    if (part.split("/").length > 2) return null
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null

    let start: number
    let end: number
    if (rangeText === "*") {
      start = minimum
      end = maximum
    } else if (rangeText.includes("-")) {
      const [startText, endText, extra] = rangeText.split("-")
      if (extra !== undefined) return null
      start = Number(startText)
      end = Number(endText)
    } else {
      start = Number(rangeText)
      end = start
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) {
      return null
    }
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value)
  }
  return values.size > 0 ? { wildcard, values } : null
}
