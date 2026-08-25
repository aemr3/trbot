import { expect, test } from "bun:test"
import { BoxRenderable, type KeyEvent } from "@opentui/core"
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

test("lets a click focus both the panel and its enclosing workspace", async () => {
  const harness = await createTestRenderer({ width: 90, height: 20 })
  let panelFocused = false
  let workspaceFocused = false
  const workspace = new BoxRenderable(harness.renderer, {
    width: "100%",
    height: "100%",
    onMouseDown: (event) => {
      if (event.button === 0) workspaceFocused = true
    },
  })
  const panel = new ChatPermissionPanel(harness.renderer, {
    request: REQUEST,
    onDecide: async () => {},
    onFocus: () => { panelFocused = true },
    onLeave: () => {},
  })
  workspace.add(panel.root)
  harness.renderer.root.add(workspace)

  const frame = await harness.waitForFrame((value) => value.includes("Permission required"))
  const line = frame.split("\n").findIndex((value) => value.includes("Permission required"))
  const column = frame.split("\n")[line]?.indexOf("Permission required") ?? -1
  await harness.mockMouse.click(column, line)

  expect(panelFocused).toBe(true)
  expect(workspaceFocused).toBe(true)
  panel.destroy()
  harness.renderer.destroy()
})

test("renders the exact action and defaults to allowing only once", async () => {
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
  expect(frame.indexOf("Allow once")).toBeLessThan(frame.indexOf("Allow for this session"))
  expect(frame.split("\n").find((line) => line.includes("▶"))).toContain("Allow once")
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(decisions).toEqual([{ decision: "ALLOW", scope: "ONCE" }])
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

test("can remember an allow decision for the session when explicitly selected", async () => {
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

  expect(decisions).toEqual([{ decision: "ALLOW", scope: "SESSION" }])
  panel.destroy()
  harness.renderer.destroy()
})
