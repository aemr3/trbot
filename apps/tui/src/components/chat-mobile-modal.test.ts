import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { ChatMobileModal } from "./chat-mobile-modal.ts"

type MobileChats = Pick<ChatSessions, "mobile" | "connectMobile">

test("shows the Telegram pairing link and its QR code", async () => {
  const harness = await createTestRenderer({ width: 100, height: 40 })
  const paired: string[] = []
  const chats: MobileChats = {
    async mobile() {
      return { available: true, connection: null }
    },
    async connectMobile(sessionId) {
      paired.push(sessionId)
      return {
        channel: "telegram",
        url: "https://t.me/trbot_test_bot?start=pairing-token",
        expiresAt: Date.now() + 300_000,
      }
    },
  }
  const modal = new ChatMobileModal(harness.renderer, {
    chats,
    sessionId: "chat-1",
    onConnected: () => {},
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)
  modal.mount()
  await until(() => paired.length === 1)
  await harness.renderOnce()

  const frame = harness.captureCharFrame()
  expect(frame).toContain("Connect phone")
  expect(frame).toContain("Scan with your phone")
  expect(frame).toContain("t.me/trbot_test_bot?start=pairing-token")
  expect(paired).toEqual(["chat-1"])

  modal.destroy()
  harness.renderer.destroy()
})

test("reports an existing connection instead of keeping the modal open", async () => {
  const harness = await createTestRenderer({ width: 90, height: 32 })
  const paired: string[] = []
  const connected: string[] = []
  const chats: MobileChats = {
    async mobile(sessionId) {
      return {
        available: true,
        connection: { sessionId, channel: "telegram", displayName: "@ada", connectedAt: 1_000 },
      }
    },
    async connectMobile(sessionId) {
      paired.push(sessionId)
      return {
        channel: "telegram",
        url: "https://t.me/trbot_test_bot?start=new-token",
        expiresAt: Date.now() + 300_000,
      }
    },
  }
  const modal = new ChatMobileModal(harness.renderer, {
    chats,
    sessionId: "chat-1",
    onConnected: (connection) => { connected.push(connection.displayName) },
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)
  modal.mount()
  await until(() => connected.length === 1)

  expect(connected).toEqual(["@ada"])
  expect(paired).toEqual([])

  modal.destroy()
  harness.renderer.destroy()
})

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for mobile modal")
}
