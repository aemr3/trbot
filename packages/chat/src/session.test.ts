import { describe, expect, test } from "bun:test"
import {
  chatBlockText,
  chatMessageText,
  ChatSessionSchema,
  chatSessionTitle,
  defaultChatSessionTitle,
  isDefaultChatSessionTitle,
  recentChatTimeline,
} from "./session.ts"

test("defaults a legacy session's missing parent prompt association to null", () => {
  const session = ChatSessionSchema.parse({
    id: "chat-1",
    title: "Legacy chat",
    parentSessionId: null,
    agent: null,
    model: "test-model",
    provider: "test-provider",
    reasoning: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    queued: 0,
    running: false,
  })

  expect(session.parentPromptMessageId).toBeNull()
  expect(session.parentToolCallId).toBeNull()
})

test("creates a recognizable timestamp placeholder", () => {
  const title = defaultChatSessionTitle(Date.UTC(2026, 7, 20, 12, 34, 56, 789))
  expect(title).toBe("New session - 2026-08-20T12:34:56.789Z")
  expect(isDefaultChatSessionTitle(title)).toBe(true)
  expect(isDefaultChatSessionTitle("Review ASELS trend")).toBe(false)
})

describe("chatSessionTitle", () => {
  test("names an empty session rather than leaving it blank", () => {
    expect(chatSessionTitle("")).toBe("New chat")
    expect(chatSessionTitle("   \n\t ")).toBe("New chat")
  })

  test("collapses the whitespace a pasted question arrives with", () => {
    expect(chatSessionTitle("  where is\n\tASELS   heading?  ")).toBe("where is ASELS heading?")
  })

  test("keeps a question that already fits on one line", () => {
    const line = "a".repeat(48)
    expect(chatSessionTitle(line)).toBe(line)
  })

  test("truncates a longer question to a single ellipsis-terminated line", () => {
    const title = chatSessionTitle("b".repeat(200))
    expect(title).toBe(`${"b".repeat(47)}…`)
    expect([...title]).toHaveLength(48)
  })

  // The truncation counts characters, not UTF-16 units, so a title cut mid-emoji
  // cannot end in half a surrogate pair — Turkish text and emoji both hit this.
  test("cuts on character boundaries", () => {
    const title = chatSessionTitle("🚀".repeat(60))
    expect([...title]).toHaveLength(48)
    expect(title.endsWith("…")).toBe(true)
    expect(title).not.toContain("�")
  })

  test("does not leave a space stranded before the ellipsis", () => {
    expect(chatSessionTitle(`${"c".repeat(46)} tail`)).toBe(`${"c".repeat(46)}…`)
  })
})

describe("chatMessageText", () => {
  test("reads only the text blocks, so thinking never reaches a transcript", () => {
    const blocks = [
      { kind: "THINKING" as const, text: "weighing it up", toolName: null, toolCallId: null, toolArguments: null },
      chatBlockText("ASELS "),
      { kind: "TOOL_CALL" as const, text: null, toolName: "quote", toolCallId: "call_1", toolArguments: { symbol: "ASELS" } },
      chatBlockText("is holding its range."),
    ]
    expect(chatMessageText(blocks)).toBe("ASELS is holding its range.")
  })

  test("reads an empty reply as empty rather than throwing", () => {
    expect(chatMessageText([])).toBe("")
  })
})

describe("recentChatTimeline", () => {
  test("keeps the newest top-level events with their tool results", () => {
    const messages = [
      { id: "old-call", role: "ASSISTANT" },
      { id: "old-result", role: "TOOL_RESULT" },
      { id: "kept-call", role: "ASSISTANT" },
      { id: "kept-result", role: "TOOL_RESULT" },
      { id: "latest", role: "ASSISTANT" },
    ]

    expect(recentChatTimeline(messages, 2).map((message) => message.id)).toEqual([
      "kept-call",
      "kept-result",
      "latest",
    ])
  })

  test("leaves an in-progress timeline of tool results intact", () => {
    const messages = [{ id: "live-result", role: "TOOL_RESULT" }]
    expect(recentChatTimeline(messages, 100)).toEqual(messages)
  })
})
