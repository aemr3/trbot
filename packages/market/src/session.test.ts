import { expect, test } from "bun:test"
import { isViopSessionScheduledOpen } from "./session.ts"

function istanbul(value: string): Date {
  return new Date(`${value}+03:00`)
}

test("follows the stock-futures session window in Istanbul", () => {
  expect(isViopSessionScheduledOpen(istanbul("2026-08-20T09:19:00"))).toBeFalse()
  expect(isViopSessionScheduledOpen(istanbul("2026-08-20T09:20:00"))).toBeTrue()
  expect(isViopSessionScheduledOpen(istanbul("2026-08-20T18:10:00"))).toBeFalse()
  expect(isViopSessionScheduledOpen(istanbul("2026-08-20T19:00:00"))).toBeFalse()
})

test("keeps the scheduled fallback closed on weekends", () => {
  expect(isViopSessionScheduledOpen(istanbul("2026-08-22T12:00:00"))).toBeFalse()
})
