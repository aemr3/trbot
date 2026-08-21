import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatPermissionReply, ChatPermissionRequest } from "@trbot/chat/permission.ts"
import { keyEvent } from "../key-event.test-fixture.ts"
import { ChatPermissionPanel } from "./chat-permission-panel.ts"

const REQUEST: ChatPermissionRequest = {
  id: "permission-1",
  sessionId: "chat-1",
  toolName: "place_viop_order",
  action: "BUY 1 F_ASELS0826 at 100 (LIMIT)",
  reason: "Open the planned position",
  scope: "SESSION",
  createdAt: 1_000,
}

function key(name: string): KeyEvent {
  return keyEvent(name, { sequence: name })
}

test("renders the exact action and remembers an allow decision for the session", async () => {
  const harness = await createTestRenderer({ width: 90, height: 20 })
  const decisions: ChatPermissionReply[] = []
  const panel = new ChatPermissionPanel(harness.renderer, {
    request: REQUEST,
    onDecide: async (decision) => { decisions.push(decision) },
    onFocus: () => {},
    onLeave: () => {},
  })
  harness.renderer.root.add(panel.root)

  const frame = await harness.waitForFrame((value) => value.includes("Permission required"))
  expect(frame).toContain("BUY 1 F_ASELS0826 at 100")
  expect(frame).toContain("Open the planned position")
  expect(frame).toContain("Allow for this session")
  expect(frame).toContain("Allow once")
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(decisions).toEqual([{ decision: "ALLOW", scope: "SESSION" }])
  panel.destroy()
  harness.renderer.destroy()
})

test("accepts an optional reason when denying the current request", async () => {
  const harness = await createTestRenderer({ width: 90, height: 20 })
  const decisions: ChatPermissionReply[] = []
  const panel = new ChatPermissionPanel(harness.renderer, {
    request: { ...REQUEST, scope: "ONCE" },
    onDecide: async (decision) => { decisions.push(decision) },
    onFocus: () => {},
    onLeave: () => {},
  })
  harness.renderer.root.add(panel.root)

  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  for (const character of "Price moved") panel.handleKey(keyEvent(character, { sequence: character }))
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(decisions).toEqual([{ decision: "DENY", reason: "Price moved" }])
  panel.destroy()
  harness.renderer.destroy()
})

test("can deny without entering a reason", async () => {
  const harness = await createTestRenderer({ width: 90, height: 20 })
  const decisions: ChatPermissionReply[] = []
  const panel = new ChatPermissionPanel(harness.renderer, {
    request: REQUEST,
    onDecide: async (decision) => { decisions.push(decision) },
    onFocus: () => {},
    onLeave: () => {},
  })
  harness.renderer.root.add(panel.root)

  panel.handleKey(key("down"))
  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(decisions).toEqual([{ decision: "DENY" }])
  panel.destroy()
  harness.renderer.destroy()
})

test("can approve only the current call from a session-capable request", async () => {
  const harness = await createTestRenderer({ width: 90, height: 20 })
  const decisions: ChatPermissionReply[] = []
  const panel = new ChatPermissionPanel(harness.renderer, {
    request: REQUEST,
    onDecide: async (decision) => { decisions.push(decision) },
    onFocus: () => {},
    onLeave: () => {},
  })
  harness.renderer.root.add(panel.root)

  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(decisions).toEqual([{ decision: "ALLOW", scope: "ONCE" }])
  panel.destroy()
  harness.renderer.destroy()
})
