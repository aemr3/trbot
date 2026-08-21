import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import type { ChatSession } from "@trbot/chat/session.ts"
import { ChatSessionModal } from "./chat-session-modal.ts"

function key(name: string, sequence?: string): KeyEvent {
  return keyEvent(name, { sequence: sequence ?? name })
}

// Local-time timestamps, so the strings below hold in any timezone.
const NOW = new Date(2026, 7, 18, 15, 0).getTime()
const TODAY = new Date(2026, 7, 18, 14, 32).getTime()
const LAST_WEEK = new Date(2026, 7, 10, 12, 0).getTime()

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1",
    title: "ASELS setup",
    parentSessionId: null,
    agent: null,
    provider: "test-provider",
    model: "test-model",
    reasoning: null,
    createdAt: LAST_WEEK,
    updatedAt: TODAY,
    messageCount: 2,
    queued: 0,
    running: false,
    ...overrides,
  }
}

async function mountModal(options: {
  sessions: ChatSession[]
  currentId?: string | null
  monitorCounts?: ReadonlyMap<string, number>
  loopCounts?: ReadonlyMap<string, number>
}) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  const selected: string[] = []
  const deleted: string[] = []
  let created = 0
  let closed = 0
  const modal = new ChatSessionModal(harness.renderer, {
    sessions: options.sessions,
    currentId: options.currentId ?? null,
    monitorCounts: options.monitorCounts,
    loopCounts: options.loopCounts,
    now: () => NOW,
    onSelect: (sessionId) => {
      selected.push(sessionId)
    },
    onCreate: () => {
      created++
    },
    onDelete: (sessionId) => {
      deleted.push(sessionId)
    },
    onClose: () => {
      closed++
    },
  })
  harness.renderer.root.add(modal.root)
  return { ...harness, modal, selected, deleted, created: () => created, closed: () => closed }
}

test("lists sessions newest first, marking the one on screen behind it", async () => {
  // Recency is the order that matters: the chat a trader wants back is nearly always
  // the one they were just in.
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    sessions: [
      session({ id: "chat-old", title: "Risk sizing", updatedAt: LAST_WEEK }),
      session({ id: "chat-new", title: "ASELS setup", updatedAt: TODAY }),
    ],
    currentId: "chat-old",
  })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("Sessions")
  expect(frame).toContain("2 sessions")
  expect(frame.indexOf("ASELS setup")).toBeLessThan(frame.indexOf("Risk sizing"))
  // Touched today shows the time, anything older the date.
  expect(frame).toContain("14:32")
  expect(frame).toContain("10 Aug")
  // The current chat is marked, so opening the modal says where you are.
  const marked = frame.split("\n").find((line) => line.includes("•"))
  expect(marked).toContain("Risk sizing")

  modal.destroy()
  renderer.destroy()
})

test("opens the highlighted chat on Enter", async () => {
  const { modal, selected, renderOnce, renderer } = await mountModal({
    sessions: [
      session({ id: "chat-new", updatedAt: TODAY }),
      session({ id: "chat-old", title: "Risk sizing", updatedAt: LAST_WEEK }),
    ],
  })
  await renderOnce()

  modal.handleKey(key("down"))
  modal.handleKey(key("return"))

  expect(selected).toEqual(["chat-old"])

  modal.destroy()
  renderer.destroy()
})

test("shows what is going on in a chat that is answering elsewhere", async () => {
  // A reply runs on the server whichever chat is on screen, so the list is where a
  // trader sees that another conversation is still working.
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    sessions: [session({ running: true, queued: 2 })],
  })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("answering")
  expect(frame).toContain("+2 queued")

  modal.destroy()
  renderer.destroy()
})

test("shows armed monitor counts beside their sessions", async () => {
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    sessions: [session()],
    monitorCounts: new Map([["chat-1", 2]]),
  })
  await renderOnce()

  expect(captureCharFrame()).toContain("2 monitors")

  modal.destroy()
  renderer.destroy()
})

test("shows active loop counts and wraps long session rows", async () => {
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    sessions: [session({
      title: "Tomorrow's unusually detailed trading opportunity review with several scenarios",
    })],
    loopCounts: new Map([["chat-1", 2]]),
  })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("Tomorrow's unusually detailed")
  expect(frame).toContain("with several scenarios")
  expect(frame).toContain("2 loops")

  modal.destroy()
  renderer.destroy()
})

test("deleting takes two presses of d, and moving off withdraws the question", async () => {
  const { modal, deleted, renderOnce, captureCharFrame, renderer } = await mountModal({
    sessions: [
      session({ id: "chat-new", title: "ASELS setup", updatedAt: TODAY }),
      session({ id: "chat-old", title: "Risk sizing", updatedAt: LAST_WEEK }),
    ],
  })
  await renderOnce()

  await mountedPress(modal, renderOnce, "d")
  expect(captureCharFrame()).toContain('Press d again to delete "ASELS setup"')
  expect(deleted).toEqual([])

  // A different chat under the cursor means the question no longer applies.
  await mountedPress(modal, renderOnce, "down")
  expect(captureCharFrame()).not.toContain("Press d again")

  await mountedPress(modal, renderOnce, "d")
  await mountedPress(modal, renderOnce, "d")
  expect(deleted).toEqual(["chat-old"])

  modal.destroy()
  renderer.destroy()
})

test("starts a session on n, and says so when there are none", async () => {
  const { modal, created, renderOnce, captureCharFrame, renderer } = await mountModal({ sessions: [] })
  await renderOnce()

  expect(captureCharFrame()).toContain("No sessions yet")

  modal.handleKey(key("n"))
  expect(created()).toBe(1)

  modal.destroy()
  renderer.destroy()
})

test("keeps the cursor where it is when a chat updates underneath it", async () => {
  // The list is live while it is open, and a repaint must not drag the cursor back to
  // the top — otherwise Enter opens whichever chat answered last.
  const { modal, selected, renderOnce, renderer } = await mountModal({
    sessions: [
      session({ id: "chat-new", updatedAt: TODAY }),
      session({ id: "chat-old", title: "Risk sizing", updatedAt: LAST_WEEK }),
    ],
  })
  await renderOnce()
  modal.handleKey(key("down"))
  await renderOnce()

  modal.setSessions(
    [
      session({ id: "chat-new", updatedAt: TODAY, running: true }),
      session({ id: "chat-old", title: "Risk sizing", updatedAt: LAST_WEEK }),
    ],
    null,
  )
  await renderOnce()
  modal.handleKey(key("return"))

  expect(selected).toEqual(["chat-old"])

  modal.destroy()
  renderer.destroy()
})

async function mountedPress(
  modal: ChatSessionModal,
  renderOnce: () => Promise<void>,
  name: string,
): Promise<void> {
  modal.handleKey(key(name))
  await renderOnce()
}
