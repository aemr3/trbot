import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ApiHttpError, AuthenticationError } from "./api/index.ts"
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
    { databaseUrl: ":memory:", credentials: null, aiModel: "gpt-5.6-sol", aiReasoningEffort: "high" },
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

test("returns to login when background device relogin fails", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  let apiClosed = false
  const api = {
    client: {
      async authenticate() {
        return { accessToken: "access", refreshToken: "refresh", memberUid: "member-1" }
      },
      async call() {
        throw new AuthenticationError("Device relogin failed")
      },
      async *stream() {},
    },
    close() {
      apiClosed = true
    },
  }
  const app = new App(
    renderer,
    { databaseUrl: ":memory:", credentials: null, aiModel: "gpt-5.6-sol", aiReasoningEffort: "high" },
    { api: api as never, sessionExpired: false },
  )
  app.mount()

  const frame = await waitForFrame((value) => value.includes("Session expired · Sign in"))
  expect(frame).toContain("Username")
  expect(apiClosed).toBeTrue()

  app.dispose()
  renderer.destroy()
})

test("keeps the workspace visible during automatic session recovery", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 20 })
  let recoveryRequested = false
  const api = {
    client: {
      async authenticate() {
        return { accessToken: "access", refreshToken: "refresh", memberUid: "member-1" }
      },
      async call() {
        throw new AuthenticationError("Device relogin failed")
      },
      async *stream() {},
    },
    close() {},
  }
  const app = new App(
    renderer,
    { databaseUrl: ":memory:", credentials: { username: "+905551234567", password: "password" }, aiModel: "gpt-5.6-sol", aiReasoningEffort: "high" },
    { api: api as never, sessionExpired: false },
    {
      recoverSession: async () => {
        recoveryRequested = true
        return new Promise<never>(() => {})
      },
    },
  )
  app.mount()

  const frame = await waitForFrame((value) => value.includes("SESSION · reconnecting…"))
  expect(recoveryRequested).toBeTrue()
  expect(frame).toContain("WATCHLIST")
  expect(frame).not.toContain("Username")

  app.dispose()
  renderer.destroy()
})

test("keeps the workspace visible when session recovery is rate limited", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 20 })
  const api = {
    client: {
      async authenticate() {
        return { accessToken: "access", refreshToken: "refresh", memberUid: "member-1" }
      },
      async call() {
        throw new AuthenticationError("Session expired")
      },
      async *stream() {},
    },
    close() {},
  }
  const app = new App(
    renderer,
    { databaseUrl: ":memory:", credentials: { username: "+905551234567", password: "password" }, aiModel: "gpt-5.6-sol", aiReasoningEffort: "high" },
    { api: api as never, sessionExpired: false },
    {
      recoverSession: async () => {
        throw new ApiHttpError(429, "Unknown Error", 12_000)
      },
    },
  )
  app.mount()

  const frame = await waitForFrame((value) => value.includes("SESSION · rate limited · retrying in 12s"))
  expect(frame).toContain("WATCHLIST")
  expect(frame).not.toContain("Username")

  app.dispose()
  renderer.destroy()
})
