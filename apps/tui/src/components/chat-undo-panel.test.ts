import { expect, test } from "bun:test"
import { type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { chatBlockText, type ChatMessage, type ChatUndoPreview } from "@trbot/chat/session.ts"
import { ChatUndoPanel } from "./chat-undo-panel.ts"

function message(id: string, text: string, role: ChatMessage["role"] = "USER"): ChatMessage {
  return {
    id,
    role,
    status: role === "USER" ? "SENT" : "COMPLETE",
    text,
    blocks: [chatBlockText(text)],
    toolName: null,
    toolCallId: null,
    isError: false,
    errorMessage: null,
    usage: null,
    model: role === "ASSISTANT" ? "test" : null,
    reasoning: null,
    elapsedMs: null,
    thinkingMs: null,
    createdAt: 1_000,
  }
}

function key(name: string): KeyEvent {
  // SAFETY: The panel reads only these stable keyboard fields in this test.
  return { name, sequence: name, ctrl: false, shift: false, meta: false, option: false } as KeyEvent
}

test("lists prompts chronologically with current selected, then confirms a rewind", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 16 })
  const undone: Array<{ message: ChatMessage; revertEffects: boolean }> = []
  let closed = false
  const panel = new ChatUndoPanel(renderer, {
    messages: [message("first", "first prompt"), message("reply", "answer", "ASSISTANT"), message("last", "last prompt")],
    loadPreview: async (selected) => ({
      prompt: selected.text,
      effects: [
        { description: "Market monitor was created", reversible: true },
        { description: "VIOP order was placed", reversible: false },
      ],
    }),
    onUndo: (selected, revertEffects) => undone.push({ message: selected, revertEffects }),
    onError: () => {},
    onClose: () => { closed = true },
  })
  renderer.root.add(panel.root)
  await renderOnce()
  const initial = captureCharFrame()
  expect(initial.indexOf("first prompt")).toBeLessThan(initial.indexOf("last prompt"))
  expect(initial.indexOf("last prompt")).toBeLessThan(initial.indexOf("(current)"))
  const initialLines = initial.split("\n")
  expect(initialLines.findIndex((line) => line.includes("last prompt"))
    - initialLines.findIndex((line) => line.includes("first prompt"))).toBe(2)
  expect(initialLines.findIndex((line) => line.includes("(current)"))
    - initialLines.findIndex((line) => line.includes("last prompt"))).toBe(2)
  expect(initialLines.findIndex((line) => line.includes("Enter to continue"))
    - initialLines.findIndex((line) => line.includes("(current)"))).toBe(2)
  expect(initial).toContain("› (current)")
  expect(initial).toContain("Enter to continue · Esc to cancel")
  expect(initial).not.toContain("╭")

  panel.handleKey(key("up"))
  panel.handleKey(key("enter"))
  await Promise.resolve()
  await renderOnce()
  expect(captureCharFrame()).toContain("Undo this message?")
  expect(captureCharFrame()).toContain("Conversation only")
  expect(captureCharFrame()).toContain("Undo: Market monitor was created")
  expect(captureCharFrame()).toContain("Keep: VIOP order was placed")
  expect(undone).toEqual([])

  panel.handleKey(key("escape"))
  await renderOnce()
  expect(captureCharFrame()).toContain("Enter to continue")
  expect(closed).toBe(false)

  panel.handleKey(key("up"))
  panel.handleKey(key("enter"))
  await Promise.resolve()
  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  expect(undone.map(({ message, revertEffects }) => ({ id: message.id, revertEffects })))
    .toEqual([{ id: "last", revertEffects: true }])

  panel.destroy()
  renderer.destroy()
})

test("continuing from the initially selected current point closes without undoing", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 14 })
  let closed = false
  const undone: ChatMessage[] = []
  const panel = new ChatUndoPanel(renderer, {
    messages: [message("first", "first prompt")],
    loadPreview: async (selected) => ({ prompt: selected.text, effects: [] }),
    onUndo: (selected) => undone.push(selected),
    onError: () => {},
    onClose: () => { closed = true },
  })

  panel.handleKey(key("enter"))

  expect(closed).toBe(true)
  expect(undone).toEqual([])
  panel.destroy()
  renderer.destroy()
})

test("shows every undo choice in one centered modal for a clicked prompt", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 20 })
  const selected = message("first", "what should we trade on monday")
  let resolvePreview: (preview: ChatUndoPreview) => void = () => {}
  const panel = new ChatUndoPanel(renderer, {
    messages: [selected],
    presentation: "modal",
    loadPreview: () => new Promise((resolve) => { resolvePreview = resolve }),
    onUndo: () => {},
    onError: () => {},
    onClose: () => {},
  })
  renderer.root.add(panel.root)
  expect(panel.openMessage(selected)).toBe(true)

  await renderOnce()
  const loading = captureCharFrame()
  expect(loading).toContain("Message actions")
  expect(loading).toContain("Undo this message?")
  expect(loading).toContain("Checking tool actions… · Esc to cancel")
  expect(loading).not.toContain("(current)")

  resolvePreview({
    prompt: selected.text,
    effects: [{ description: "Market monitor was created", reversible: true }],
  })
  await Promise.resolve()
  await renderOnce()
  const confirmation = captureCharFrame()
  expect(confirmation).toContain("╭")
  expect(confirmation).toContain("Conversation only")
  expect(confirmation).toContain("Conversation + reversible actions")
  expect(confirmation).toContain("Undo: Market monitor was created")

  panel.destroy()
  renderer.destroy()
})

test("wraps prompts to at most three lines and marks truncation", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 44, height: 18 })
  const panel = new ChatUndoPanel(renderer, {
    messages: [message(
      "long",
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec tail-marker",
    )],
    loadPreview: async (selected) => ({ prompt: selected.text, effects: [] }),
    onUndo: () => {},
    onError: () => {},
    onClose: () => {},
  })
  renderer.root.add(panel.root)

  await renderOnce()
  await renderOnce()
  const frame = captureCharFrame()
  const lines = frame.split("\n")
  const promptStart = lines.findIndex((line) => line.includes("alpha"))
  const currentStart = lines.findIndex((line) => line.includes("(current)"))
  const promptLines = lines.slice(promptStart, currentStart)

  expect(promptLines.filter((line) => line.trim().length > 0)).toHaveLength(3)
  expect(promptLines.at(-1)?.trim()).toBe("")
  expect(promptLines.at(-2)).toContain("...")
  expect(frame).not.toContain("tail-marker")

  panel.destroy()
  renderer.destroy()
})

test("keeps a blank row before the footer when the prompt list scrolls", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 70, height: 18 })
  const panel = new ChatUndoPanel(renderer, {
    messages: Array.from({ length: 7 }, (_, index) => message(`prompt-${index}`, `prompt ${index}`)),
    loadPreview: async (selected) => ({ prompt: selected.text, effects: [] }),
    onUndo: () => {},
    onError: () => {},
    onClose: () => {},
  })
  renderer.root.add(panel.root)

  await renderOnce()
  await renderOnce()
  const lines = captureCharFrame().split("\n")
  const currentLine = lines.findIndex((line) => line.includes("(current)"))
  const footerLine = lines.findIndex((line) => line.includes("Enter to continue"))

  expect(panel.root.height).toBe(16)
  expect(currentLine).toBeGreaterThan(-1)
  expect(footerLine - currentLine).toBe(2)

  panel.destroy()
  renderer.destroy()
})
