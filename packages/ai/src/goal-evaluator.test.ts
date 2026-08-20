import { expect, test } from "bun:test"
import { parseGoalEvaluation } from "./goal-evaluator.ts"

test("parses a strict goal verdict from plain or fenced JSON", () => {
  expect(parseGoalEvaluation('{"verdict":"CONTINUE","reason":"One check remains."}')).toEqual({
    verdict: "CONTINUE",
    reason: "One check remains.",
  })
  expect(parseGoalEvaluation('```json\n{"verdict":"COMPLETE","reason":"Verified."}\n```').verdict).toBe("COMPLETE")
})

test("rejects evaluator prose that does not satisfy the verdict contract", () => {
  expect(() => parseGoalEvaluation("Looks done to me.")).toThrow("no JSON object")
  expect(() => parseGoalEvaluation('{"verdict":"MAYBE","reason":"Unsure."}')).toThrow()
})
