import { expect, test } from "bun:test"
import { ApplicationLog } from "./application-log.ts"

test("retains bounded structured error details without request credentials", () => {
  const logs = new ApplicationLog(2, () => 100)
  const error = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    url: "https://chatgpt.com/backend-api/codex/responses",
    responseBody: '{"detail":"Unsupported field"}',
    isRetryable: false,
  })

  logs.info("Application", "started")
  logs.error("Reinforcement backtest", error)
  logs.warn("Market data", "delayed")

  const entries = logs.list()
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ level: "ERROR", scope: "Reinforcement backtest", message: "Bad Request" })
  expect(entries[0]?.details).toContain('"statusCode": 400')
  expect(entries[0]?.details).toContain("Unsupported field")
  expect(entries[0]?.details).not.toContain("Authorization")
})
