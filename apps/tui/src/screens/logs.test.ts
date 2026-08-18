import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ApplicationLog } from "../logging/application-log.ts"
import { LogsScreen } from "./logs.ts"

test("renders, scrolls, clears, and closes application logs", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const logs = new ApplicationLog(10, () => Date.parse("2026-08-11T09:30:00+03:00"))
  logs.error("Market data", Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: '{"detail":"Unknown parameter: max_output_tokens"}',
  }))
  let closed = false
  const screen = new LogsScreen(renderer, { logs, onClose: () => { closed = true } })
  renderer.root.add(screen.root)
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))

  const frame = await waitForFrame((value) => value.includes("APPLICATION LOGS") && value.includes("Unknown parameter"))
  expect(frame).toContain("ERROR")
  expect(frame).toContain("Market data")
  expect(frame).toContain("Bad Request")
  const lines = frame.split("\n")
  expect(lines[0]?.indexOf("APPLICATION LOGS")).toBe(1)
  expect(lines.at(-2)).toContain("T / Esc trade")

  await mockInput.typeText("c")
  await waitForFrame((value) => value.includes("No logs yet."))
  mockInput.pressEscape()
  expect(closed).toBe(true)

  screen.destroy()
  renderer.destroy()
})
