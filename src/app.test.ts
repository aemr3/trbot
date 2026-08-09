import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { App } from "./app.ts"

test("restores the terminal synchronously on Ctrl+C", async () => {
  const { renderer, mockInput } = await createTestRenderer({
    width: 80,
    height: 20,
    kittyKeyboard: true,
  })
  let exitRequested = false
  let preferencesClosed = false
  const app = new App(
    renderer,
    { databaseUrl: ":memory:", credentials: null },
    { api: null, sessionExpired: false },
    {
      exit: () => {
        expect(renderer.isDestroyed).toBe(true)
        exitRequested = true
      },
      closePreferences: () => {
        preferencesClosed = true
      },
    },
  )
  app.mount()

  mockInput.pressCtrlC()

  expect(renderer.isDestroyed).toBe(true)
  expect(exitRequested).toBe(true)
  expect(preferencesClosed).toBe(true)
})
