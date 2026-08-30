import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { HttpClient } from "@trbot/client/http.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { LoginScreen } from "./login.ts"

test("requests a new SMS from the OTP screen after the code expires", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  const renewedAt = Date.now() + 180_000
  const requests: Array<{ method: string | undefined; path: string; body: BodyInit | null | undefined }> = []
  const http = new HttpClient({
    url: "http://trbot.test",
    token: "test-token",
    fetch: async (input, init) => {
      requests.push({
        method: init?.method,
        path: new URL(input.toString()).pathname,
        body: init?.body,
      })
      return Response.json({ authenticated: false, otp: { expiresAt: renewedAt } })
    },
  })
  const screen = new LoginScreen(setup.renderer, http, {
    initialOtp: { expiresAt: Date.now() - 1 },
    onAuthenticated() {},
  })

  try {
    setup.renderer.root.add(screen.root)
    screen.mount()
    await setup.renderOnce()

    const expired = setup.captureCharFrame()
    expect(expired).toContain("The SMS code has expired")
    expect(expired).toContain("Ctrl+R to request a new SMS")
    expect(expired).not.toContain("Password")

    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Enter the verification code sent by SMS"))

    expect(requests).toEqual([{ method: "POST", path: ROUTES.otpResend, body: undefined }])
    expect(setup.captureCharFrame()).toContain("Expires in")
  } finally {
    screen.destroy()
    setup.renderer.destroy()
  }
})

test("does not offer or request another SMS while the current code is valid", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  let requests = 0
  const http = new HttpClient({
    url: "http://trbot.test",
    token: "test-token",
    fetch: async () => {
      requests += 1
      return Response.json({ authenticated: false, otp: null })
    },
  })
  const screen = new LoginScreen(setup.renderer, http, {
    initialOtp: { expiresAt: Date.now() + 60_000 },
    onAuthenticated() {},
  })

  try {
    setup.renderer.root.add(screen.root)
    screen.mount()
    await setup.renderOnce()

    const active = setup.captureCharFrame()
    expect(active).toContain("Expires in")
    expect(active).not.toContain("Ctrl+R to request a new SMS")

    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.renderOnce()
    expect(requests).toBe(0)
  } finally {
    screen.destroy()
    setup.renderer.destroy()
  }
})
