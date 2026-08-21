import { expect, test } from "bun:test"
import { CreateChatGoalSchema, parseLoopInterval } from "./automation.ts"

test("parses compact loop intervals and rounds seconds to minute granularity", () => {
  expect(parseLoopInterval("5m")).toBe(300_000)
  expect(parseLoopInterval("2H")).toBe(7_200_000)
  expect(parseLoopInterval("1d")).toBe(86_400_000)
  expect(parseLoopInterval("30s")).toBe(60_000)
  expect(parseLoopInterval("61s")).toBe(120_000)
  expect(parseLoopInterval("0m")).toBeNull()
})

test("validates a goal without transport-owned defaults", () => {
  expect(CreateChatGoalSchema.parse({ objective: "  finish the report  " })).toEqual({
    objective: "finish the report",
  })
  expect(CreateChatGoalSchema.safeParse({ objective: "" }).success).toBe(false)
})
