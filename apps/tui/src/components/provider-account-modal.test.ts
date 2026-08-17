import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatGptAccount } from "@trbot/ai/chatgpt-account.ts"
import type { ProviderState } from "@trbot/ai/provider-state.ts"
import { ProviderAccountModal } from "./provider-account-modal.ts"

test("connects and disconnects ChatGPT from the provider modal", async () => {
  const { renderer, mockInput, waitFor, waitForFrame } = await createTestRenderer({
    width: 90,
    height: 24,
    kittyKeyboard: true,
  })
  let state: ProviderState | null = null
  const account: ChatGptAccount = {
    async getState() {
      return state
    },
    async connect(options) {
      options?.onAuthorizationUrl?.("https://auth.openai.test/authorize")
      state = connectedState()
      return state
    },
    async disconnect() {
      state = null
    },
  }
  let closed = false
  const modal = new ProviderAccountModal(renderer, { account, onClose: () => { closed = true } })
  renderer.root.add(modal.root)
  modal.mount()
  renderer.keyInput.on("keypress", (key) => modal.handleKey(key))

  await waitForFrame((frame) => frame.includes("Not connected"))
  mockInput.pressEnter()
  const connected = await waitForFrame((frame) => frame.includes("Connected"))
  expect(connected).toContain("trader@example.com")

  await mockInput.typeText("d")
  await waitForFrame((frame) => frame.includes("Not connected"))
  mockInput.pressEscape()
  await waitFor(() => closed)
  expect(closed).toBe(true)

  modal.destroy()
  renderer.destroy()
})

function connectedState(): ProviderState {
  return {
    providerId: "openai",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-1",
    email: "trader@example.com",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
