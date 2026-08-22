import { describe, expect, test } from "bun:test"
import { isMarketOpen, parseSessionWindows } from "./session-hours.ts"

/** Istanbul is UTC+3 year round, so these read as local times minus three hours. */
function istanbul(day: string, time: string): number {
  const [hour, minute] = time.split(":").map(Number)
  return Date.parse(`${day}T${String((hour ?? 0) - 3).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}:00Z`)
}

// 2026-08-21 is a Friday; 2026-08-22 a Saturday.
const FRIDAY = "2026-08-21"
const SATURDAY = "2026-08-22"

describe("parseSessionWindows", () => {
  test("reads a single equity session", () => {
    expect(parseSessionWindows("0955-1810")).toEqual([{ openMinute: 9 * 60 + 55, closeMinute: 18 * 60 + 10 }])
  })

  // Index futures trade an evening session on top of the day session.
  test("reads a two-window futures session", () => {
    expect(parseSessionWindows("0920-1810,1900-2300")).toEqual([
      { openMinute: 9 * 60 + 20, closeMinute: 18 * 60 + 10 },
      { openMinute: 19 * 60, closeMinute: 23 * 60 },
    ])
  })

  /** An always-open instrument has no windows to compare against. */
  test("reports no windows for a round-the-clock symbol", () => {
    expect(parseSessionWindows("24x7")).toBeNull()
  })

  test("reports no windows for something it cannot read", () => {
    expect(parseSessionWindows(null)).toBeNull()
    expect(parseSessionWindows("")).toBeNull()
    expect(parseSessionWindows("whenever")).toBeNull()
    // A close at or before the open is not a window.
    expect(parseSessionWindows("1810-0955")).toBeNull()
  })
})

describe("isMarketOpen", () => {
  test("is open inside the session", () => {
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "13:00"))).toBe(true)
  })

  test("is closed before the open and after the close", () => {
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "09:30"))).toBe(false)
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "21:00"))).toBe(false)
  })

  // The reported failure: an equity book read after the close.
  test("is closed at the hour an empty book was mistaken for a missing one", () => {
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "23:00"))).toBe(false)
  })

  test("treats the close as exclusive and the open as inclusive", () => {
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "09:55"))).toBe(true)
    expect(isMarketOpen("0955-1810", istanbul(FRIDAY, "18:10"))).toBe(false)
  })

  test("honours an evening session", () => {
    expect(isMarketOpen("0920-1810,1900-2300", istanbul(FRIDAY, "21:00"))).toBe(true)
    // The gap between the two windows is still closed.
    expect(isMarketOpen("0920-1810,1900-2300", istanbul(FRIDAY, "18:30"))).toBe(false)
  })

  test("is closed at the weekend", () => {
    expect(isMarketOpen("0955-1810", istanbul(SATURDAY, "13:00"))).toBe(false)
  })

  test("keeps a round-the-clock symbol open, weekend included", () => {
    expect(isMarketOpen("24x7", istanbul(SATURDAY, "03:00"))).toBe(true)
  })

  /**
   * Reporting a market closed on a session string this cannot read would hide a
   * live book, which is worse than showing a stale-looking empty one.
   */
  test("assumes open when the session cannot be read", () => {
    expect(isMarketOpen(null, istanbul(SATURDAY, "03:00"))).toBe(true)
    expect(isMarketOpen("whenever", istanbul(FRIDAY, "23:00"))).toBe(true)
  })
})
