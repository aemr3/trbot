import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { chatBlockText, type ChatMessage, type ChatSession, type ChatSessionDetail } from "@trbot/chat/session.ts"
import type { AiAccount, AiAccountSummary } from "@trbot/protocol/ai.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { ApplicationLog } from "../logging/application-log.ts"
import { AiScreen } from "./ai.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"

/** A server-side chat, near enough for a screen to be driven against. */
function fakeChats(): ChatSessions & { sessions: ChatSession[]; sent: string[]; cancelled: string[]; aborted: string[] } {
  const sessions: ChatSession[] = []
  const messages = new Map<string, ChatMessage[]>()
  const sent: string[] = []
  const cancelled: string[] = []
  const aborted: string[] = []

  return {
    sessions,
    sent,
    cancelled,
    aborted,
    async list() {
      // A copy, as a real client's answer would be: handing out the live array
      // would let the screen and the fake share state no server ever shares.
      return [...sessions]
    },
    async create() {
      const session: ChatSession = {
        id: `chat-${sessions.length + 1}`,
        title: "New chat",
        model: "test-model",
        createdAt: 1_000,
        updatedAt: 1_000,
        messageCount: 0,
        queued: 0,
        running: false,
      }
      sessions.push(session)
      messages.set(session.id, [])
      return session
    },
    async get(sessionId): Promise<ChatSessionDetail> {
      const session = sessions.find((entry) => entry.id === sessionId)
      if (!session) throw new Error("no such chat")
      return { session, messages: messages.get(sessionId) ?? [], partial: null }
    },
    async delete(sessionId) {
      const index = sessions.findIndex((entry) => entry.id === sessionId)
      if (index >= 0) sessions.splice(index, 1)
      messages.delete(sessionId)
    },
    async send(sessionId, text) {
      sent.push(text)
      const message = userMessage(text, "QUEUED")
      messages.set(sessionId, [...(messages.get(sessionId) ?? []), message])
      return message
    },
    async cancel(_sessionId, messageId) {
      cancelled.push(messageId)
    },
    async abort(sessionId) {
      aborted.push(sessionId)
    },
  }
}

function userMessage(text: string, status: ChatMessage["status"]): ChatMessage {
  return {
    id: `message-${text}`,
    role: "USER",
    status,
    text,
    blocks: [chatBlockText(text)],
    toolName: null,
    toolCallId: null,
    isError: false,
    errorMessage: null,
    usage: null,
    createdAt: 1_000,
  }
}

function replyMessage(text: string, status: ChatMessage["status"] = "COMPLETE"): ChatMessage {
  return { ...userMessage(text, status), id: `reply-${text}`, role: "ASSISTANT" }
}

function account(state: AiAccountSummary | null): AiAccount {
  let current = state
  return {
    async getState() {
      return current
    },
    async connect() {
      current = { providerId: "openai", accountId: "account-1", connectedAt: 1, updatedAt: 1 }
      return current
    },
    async disconnect() {
      current = null
    },
  }
}

const connected: AiAccountSummary = {
  providerId: "openai",
  accountId: "account-1",
  connectedAt: 1,
  updatedAt: 1,
}

test("asks the trader to connect ChatGPT before offering a composer", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const screen = new AiScreen(renderer, { chats: fakeChats(), account: account(null), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))

  // Nothing to type into while there is no connection: the instruction is the
  // only thing on offer.
  const gate = await waitForFrame((frame) => frame.includes("ChatGPT is not connected"))
  expect(gate).not.toContain("ask something")

  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("AI provider"))
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Connected"))
  mockInput.pressEscape()
  // Connecting in the modal is what opens the chat, without leaving the tab.
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.destroy()
  renderer.destroy()
})

test("sends what is typed and shows it waiting its turn", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const screen = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("where is ASELS heading?")
  mockInput.pressEnter()

  await waitForFrame((frame) => frame.includes("where is ASELS heading?"))
  expect(chats.sent).toEqual(["where is ASELS heading?"])
  // Queued is shown, not hidden: a trader can see what the model has not reached
  // yet, and that it can still be taken back.
  const queued = await waitForFrame((frame) => frame.includes("queued"))
  expect(queued).toContain("x to take back")

  screen.destroy()
  renderer.destroy()
})

test("renders a reply as it streams and replaces it with the stored message", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptDelta(session.id, "run-1", { reasoning: "weighing the tape" })
  // While there are no words yet, the reasoning is what says the model is working.
  await waitForFrame((frame) => frame.includes("weighing the tape"))

  screen.acceptDelta(session.id, "run-1", { text: "Heading " })
  screen.acceptDelta(session.id, "run-1", { text: "higher." })
  await waitForFrame((frame) => frame.includes("Heading higher."))

  screen.acceptMessage(session.id, replyMessage("Heading higher."))
  screen.acceptRun(session.id, "run-1", "done")
  // The stored reply takes the place of what was streaming rather than joining it,
  // which would show the same words twice.
  const settled = await waitForFrame((frame) => frame.includes("Heading higher."))
  expect(settled.split("Heading higher.").length - 1).toBe(1)

  screen.destroy()
  renderer.destroy()
})

test("keeps one transcript per session and switches between them", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const first = await chats.create()
  const second = await chats.create()
  const screen = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptSessions([
    { ...first, title: "ASELS setup" },
    { ...second, title: "Risk sizing" },
  ])
  screen.acceptMessage(first.id, replyMessage("about ASELS"))
  screen.acceptMessage(second.id, replyMessage("about risk"))
  await waitForFrame((frame) => frame.includes("about ASELS") && !frame.includes("about risk"))

  // Tab out of the composer first: while it holds focus, letters are text.
  mockInput.pressTab()
  await mockInput.typeText("j")
  await waitForFrame((frame) => frame.includes("about risk") && !frame.includes("about ASELS"))

  screen.destroy()
  renderer.destroy()
})

test("takes back the message still waiting, and stops the reply that is running", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, userMessage("waiting", "QUEUED"))
  screen.acceptDelta(session.id, "run-1", { text: "answering" })
  await waitForFrame((frame) => frame.includes("waiting") && frame.includes("answering"))

  mockInput.pressTab()
  await mockInput.typeText("x")
  await waitForFrame(() => chats.cancelled.length > 0)
  expect(chats.cancelled).toEqual(["message-waiting"])

  mockInput.pressEscape()
  await waitForFrame(() => chats.aborted.length > 0)
  // Two separate decisions: taking a question back is not the same as stopping the
  // answer already being written.
  expect(chats.aborted).toEqual([session.id])

  screen.destroy()
  renderer.destroy()
})

test("deleting a session takes two presses of d", async () => {
  const { renderer, mockInput, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  await chats.create()
  const screen = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))
  screen.acceptSessions([{ ...chats.sessions[0]!, title: "ASELS setup" }])
  await waitForFrame((frame) => frame.includes("ASELS setup"))

  mockInput.pressTab()
  await mockInput.typeText("d")
  // The screen coalesces its repaints, so the frame is captured after that has run
  // rather than waiting on a new one: nothing else moves while a prompt is up.
  await Bun.sleep(20)
  await renderOnce()
  // A conversation cannot be recovered, and d sits next to the keys that move the
  // selection, so the first press only asks.
  expect(captureCharFrame()).toContain('Press d again to delete "ASELS setup"')
  expect(chats.sessions).toHaveLength(1)

  await mockInput.typeText("d")
  await Bun.sleep(20)
  expect(chats.sessions).toEqual([])
  await renderOnce()
  expect(captureCharFrame()).not.toContain("ASELS setup")

  screen.destroy()
  renderer.destroy()
})

test("typing in the composer never changes tab", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const chats = fakeChats()
  const ai = new AiScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  const trade = labelledPanel(renderer, "TRADE PANEL")
  const logs = labelledPanel(renderer, "LOG PANEL")
  const workspace = new TradingWorkspaceScreen(renderer, { trade, ai, logs })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("a", { shift: true })
  await waitForFrame((frame) => frame.includes("ask something"))

  // "Tomorrow" holds a T and an L: without the composer claiming its keys, typing
  // it would walk the trader through every tab.
  await mockInput.typeText("Tomorrow, ASELS?")
  const frame = await waitForFrame((content) => content.includes("Tomorrow, ASELS?"))
  expect(frame).not.toContain("TRADE PANEL")
  expect(frame).not.toContain("LOG PANEL")

  // Leaving the field gives the keys back to the tab bar.
  mockInput.pressTab()
  mockInput.pressKey("t", { shift: true })
  await waitForFrame((content) => content.includes("TRADE PANEL"))

  workspace.destroy()
  renderer.destroy()
})

function labelledPanel(renderer: RenderContext, label: string): {
  root: BoxRenderable
  handleKey(): void
  destroy(): void
} {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%" })
  root.add(new TextRenderable(renderer, { content: label }))
  return {
    root,
    handleKey: () => {},
    destroy: () => {
      if (!root.isDestroyed) root.destroyRecursively()
    },
  }
}
