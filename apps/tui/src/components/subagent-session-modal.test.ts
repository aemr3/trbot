import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatSession } from "@trbot/chat/session.ts"
import { SubagentSessionModal } from "./subagent-session-modal.ts"

const NOW = new Date(2026, 7, 18, 15, 0).getTime()

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "worker-1",
    title: "Inspect the market",
    parentSessionId: "chat-1",
    parentPromptMessageId: "prompt-1",
    agent: "worker",
    provider: "test-provider",
    model: "test-model",
    reasoning: null,
    createdAt: NOW,
    updatedAt: NOW,
    messageCount: 1,
    queued: 0,
    running: true,
    ...overrides,
  }
}

test("marks working subagents at the front of the row and updates when they finish", async () => {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  const working = session()
  const modal = new SubagentSessionModal(harness.renderer, {
    sessions: [working],
    currentId: null,
    now: () => NOW,
    onSelect: () => {},
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)

  try {
    await harness.renderOnce()
    const workingLine = harness.captureCharFrame().split("\n")
      .find((line) => line.includes(working.title))
    expect(workingLine).toContain(`● 15:00 ${working.title}`)

    modal.setSessions([{ ...working, running: false }], null)
    await harness.renderOnce()
    const finishedLine = harness.captureCharFrame().split("\n")
      .find((line) => line.includes(working.title))
    expect(finishedLine).toContain(`✓ 15:00 ${working.title}`)
    expect(finishedLine).not.toContain("●")
  } finally {
    modal.destroy()
    harness.renderer.destroy()
  }
})

test("wraps long subagent rows instead of clipping their titles", async () => {
  const harness = await createTestRenderer({ width: 52, height: 18 })
  const title = "Read-only broad live scan for the final allowable setup"
  const modal = new SubagentSessionModal(harness.renderer, {
    sessions: [session({ title })],
    currentId: null,
    now: () => NOW,
    onSelect: () => {},
    onClose: () => {},
  })
  harness.renderer.root.add(modal.root)

  try {
    const frame = await harness.waitForFrame((value) => (
      value.includes("Subagents") && value.includes("final allowable setup")
    ))
    expect(frame).toContain("Read-only broad live scan")
    expect(frame).toContain("final allowable setup")
  } finally {
    modal.destroy()
    harness.renderer.destroy()
  }
})
