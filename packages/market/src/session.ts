const ISTANBUL_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Istanbul",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

const NORMAL_OPEN = 9 * 60 + 20
const NORMAL_CLOSE = 18 * 60 + 10
/** Whether the stock-futures session is scheduled to accept orders at this time. */
export function isViopSessionScheduledOpen(at: Date): boolean {
  const parts = Object.fromEntries(ISTANBUL_TIME.formatToParts(at).map((part) => [part.type, part.value]))
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false

  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return between(minutes, NORMAL_OPEN, NORMAL_CLOSE)
}

function between(value: number, start: number, end: number): boolean {
  return value >= start && value < end
}
