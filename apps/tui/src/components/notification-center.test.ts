import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import { createTestRenderer } from "@opentui/core/testing"
import { NotificationCenter } from "./notification-center.ts"

function key(name: string): KeyEvent {
  return keyEvent(name)
}

test("stacks notifications and runs the selected action", async () => {
  const { renderer, renderOnce, captureCharFrame, mockMouse } = await createTestRenderer({ width: 100, height: 28 })
  const events: string[] = []
  const center = new NotificationCenter(renderer)
  renderer.root.add(center.root)
  center.add({
    id: "one",
    title: "First question",
    body: "Which setup?",
    actions: [{ label: "Open chat", onSelect: () => events.push("open-one") }],
  })
  center.add({
    id: "two",
    title: "Second question",
    body: "Which timeframe?",
    actions: [
      { label: "Open chat", onSelect: () => events.push("open-two") },
      { label: "Stay here", onSelect: () => events.push("stay-two") },
    ],
  })

  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("First question")
  expect(frame).toContain("Second question")
  expect(center.count).toBe(2)

  const lines = frame.split("\n")
  const actionsY = lines.findLastIndex((line) => line.includes("Open chat") && line.includes("Stay here"))
  await mockMouse.click(lines[actionsY]?.indexOf("Stay here") ?? -1, actionsY)
  expect(events).toEqual(["stay-two"])
  expect(center.count).toBe(1)
  expect(renderer.getSelection()).toBeNull()

  center.destroy()
  renderer.destroy()
})

test("Escape dismisses only the selected notification", async () => {
  const events: string[] = []
  const { renderer } = await createTestRenderer({ width: 80, height: 20 })
  const center = new NotificationCenter(renderer)
  center.add({ id: "one", title: "One", body: "First", onDismiss: () => events.push("one") })
  center.add({ id: "two", title: "Two", body: "Second", onDismiss: () => events.push("two") })

  center.handleKey(key("escape"))

  expect(events).toEqual(["two"])
  expect(center.count).toBe(1)
  center.destroy()
  renderer.destroy()
})
