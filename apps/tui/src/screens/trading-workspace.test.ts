import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { SoundCue } from "../components/sound.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"

/**
 * A panel, near enough for the workspace to be driven against.
 *
 * `capturesInput` is the only thing the workspace asks of a panel beyond drawing
 * itself, so a fake that answers it exercises the tab shortcuts without a real screen.
 */
function panel(renderer: RenderContext, label: string, options: { capturesInput?: boolean; showingSession?: string } = {}): {
  root: BoxRenderable
  keys: KeyEvent[]
  openedQuestions: string[]
  openedSessions: string[]
  dismissedNotifications: string[]
  handleKey(key: KeyEvent): void
  capturesInput(): boolean
  openQuestion(sessionId: string): void
  openSession(sessionId: string): void
  dismissNotification(notificationId: string): void
  isShowingSession(sessionId: string): boolean
  destroy(): void
} {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%" })
  root.add(new TextRenderable(renderer, { content: label }))
  const keys: KeyEvent[] = []
  const openedQuestions: string[] = []
  const openedSessions: string[] = []
  const dismissedNotifications: string[] = []
  let showingSession = options.showingSession
  return {
    root,
    keys,
    openedQuestions,
    openedSessions,
    dismissedNotifications,
    handleKey: (key) => {
      keys.push(key)
    },
    capturesInput: () => options.capturesInput ?? false,
    openQuestion: (sessionId) => {
      openedQuestions.push(sessionId)
      showingSession = sessionId
    },
    openSession: (sessionId) => {
      openedSessions.push(sessionId)
      showingSession = sessionId
    },
    dismissNotification: (notificationId) => {
      dismissedNotifications.push(notificationId)
    },
    isShowingSession: (sessionId) => showingSession === sessionId,
    destroy: () => {
      if (!root.isDestroyed) root.destroyRecursively()
    },
  }
}

function question(id: string): ChatQuestionRequest {
  return {
    id,
    sessionId: `chat-${id}`,
    questions: [{
      header: "Strategy",
      question: `How should ${id} continue?`,
      options: [{ label: "Continue", description: "Keep working" }],
    }],
  }
}

function notification(id: string): ChatNotification {
  return {
    id,
    sessionId: `chat-${id}`,
    title: `Notice ${id}`,
    message: `Agent update for ${id}.`,
    urgency: "INFO",
    createdAt: 1_000,
  }
}

async function mountWorkspace(options: { capturesInput?: boolean; showingSession?: string } = {}) {
  const harness = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL", options)
  const chat = panel(harness.renderer, "CHAT PANEL", options)
  const logs = panel(harness.renderer, "LOG PANEL", options)
  const workspace = new TradingWorkspaceScreen(harness.renderer, { trade, chat, logs })
  harness.renderer.root.add(workspace.root)
  workspace.mount()
  return { ...harness, workspace, trade, chat, logs }
}

test("^A, ^T, and ^G select their tabs while a panel is taking text", async () => {
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace({ capturesInput: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("g", { ctrl: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  mockInput.pressKey("t", { ctrl: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("shift does not change which tab a control shortcut selects", async () => {
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("a", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  mockInput.pressKey("g", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  mockInput.pressKey("t", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("each tab answers to its own initial while no panel is taking text", async () => {
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("l", { shift: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  mockInput.pressKey("c", { shift: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("a panel taking text keeps the letters, and the workspace keeps the control keys", async () => {
  const { renderer, mockInput, waitForFrame, workspace, trade } = await mountWorkspace({ capturesInput: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  // A tab initial typed into a field is text, and reaches the panel rather than the
  // tab bar: a trader typing "Logs" would otherwise leave the screen mid-word.
  mockInput.pressKey("l", { shift: true })
  await Bun.sleep(5)
  expect(trade.keys.map((key) => key.name)).toEqual(["l"])

  mockInput.pressKey("g", { ctrl: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  expect(trade.keys.map((key) => key.name)).toEqual(["l"])

  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  // The workspace took both control keys, so the panel never saw them.
  expect(trade.keys.map((key) => key.name)).toEqual(["l"])

  workspace.destroy()
  renderer.destroy()
})

test("a question notice can open its originating chat", async () => {
  const { renderer, mockInput, waitForFrame, workspace, chat } = await mountWorkspace()
  const request = question("one")
  workspace.notifyQuestion(request, false)
  await waitForFrame((frame) => frame.includes("Agent needs your answer") && frame.includes("Open chat"))

  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("CHAT PANEL") && !frame.includes("Agent needs your answer"))

  expect(chat.openedQuestions).toEqual(["chat-one"])
  workspace.destroy()
  renderer.destroy()
})

test("question notices stack, sound once each, and Escape dismisses only one", async () => {
  const harness = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL")
  const chat = panel(harness.renderer, "CHAT PANEL")
  const logs = panel(harness.renderer, "LOG PANEL")
  const cues: SoundCue[] = []
  const workspace = new TradingWorkspaceScreen(harness.renderer, {
    trade,
    chat,
    logs,
    sound: { play: (cue) => cues.push(cue) },
  })
  harness.renderer.root.add(workspace.root)
  workspace.mount()

  workspace.notifyQuestion(question("one"), false)
  workspace.notifyQuestion(question("two"), false)
  workspace.notifyQuestion(question("two"), false)
  await harness.waitForFrame((frame) => frame.includes("How should one continue?") && frame.includes("How should two continue?"))

  harness.mockInput.pressEscape()
  const remaining = await harness.waitForFrame((frame) => frame.includes("How should one continue?") && !frame.includes("How should two continue?"))
  expect(remaining).toContain("TRADE PANEL")
  expect(cues).toEqual(["QUESTION", "QUESTION"])

  workspace.destroy()
  harness.renderer.destroy()
})

test("leaving a chat surfaces its still-pending question", async () => {
  const { renderer, waitForFrame, renderOnce, captureCharFrame, workspace } = await mountWorkspace({ showingSession: "chat-one" })
  workspace.selectTab("chat")
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))

  workspace.notifyQuestion(question("one"), true)
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Agent needs your answer")

  workspace.selectTab("trade")
  await waitForFrame((frame) => frame.includes("Agent needs your answer") && frame.includes("How should one continue?"))

  workspace.destroy()
  renderer.destroy()
})

test("agent notifications stack, sound once, and open their originating chat", async () => {
  const harness = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL")
  const chat = panel(harness.renderer, "CHAT PANEL")
  const logs = panel(harness.renderer, "LOG PANEL")
  const cues: SoundCue[] = []
  const workspace = new TradingWorkspaceScreen(harness.renderer, {
    trade,
    chat,
    logs,
    sound: { play: (cue) => cues.push(cue) },
  })
  harness.renderer.root.add(workspace.root)
  workspace.mount()

  workspace.notifyAgent(notification("one"))
  workspace.notifyAgent(notification("two"))
  workspace.notifyAgent(notification("two"))
  await harness.waitForFrame((frame) => frame.includes("Notice one") && frame.includes("Notice two"))

  harness.mockInput.pressEnter()
  await harness.waitForFrame((frame) => frame.includes("CHAT PANEL") && !frame.includes("Notice two"))

  expect(chat.openedSessions).toEqual(["chat-two"])
  expect(chat.dismissedNotifications).toEqual(["two"])
  expect(cues).toEqual(["NOTIFICATION", "NOTIFICATION"])

  workspace.destroy()
  harness.renderer.destroy()
})
