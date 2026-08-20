import { expect, test } from "bun:test"
import { isValidCronExpression, nextCronOccurrence } from "./schedule.ts"

test("accepts the supported five-field cron syntax", () => {
  expect(isValidCronExpression("*/5 * * * *")).toBe(true)
  expect(isValidCronExpression("0 9 * * 1-5")).toBe(true)
  expect(isValidCronExpression("1,15,30 8-18/2 * * *")).toBe(true)
  expect(isValidCronExpression("0 9 * JAN MON")).toBe(false)
  expect(isValidCronExpression("*/0 * * * *")).toBe(false)
})

test("finds the next cron occurrence in local time", () => {
  const after = new Date(2026, 0, 5, 8, 58, 20).getTime()
  expect(nextCronOccurrence("0 9 * * 1-5", after)).toBe(new Date(2026, 0, 5, 9, 0).getTime())
  expect(nextCronOccurrence("30 14 15 3 *", after)).toBe(new Date(2026, 2, 15, 14, 30).getTime())
})

test("uses Vixie cron OR semantics when both day fields are restricted", () => {
  const after = new Date(2026, 0, 5, 9, 0).getTime()
  expect(nextCronOccurrence("0 9 10 * 2", after)).toBe(new Date(2026, 0, 6, 9, 0).getTime())
})
