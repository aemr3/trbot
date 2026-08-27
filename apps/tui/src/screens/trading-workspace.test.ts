import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { ChatPermissionRequest } from "@trbot/chat/permission.ts"
import type { SoundCue } from "../components/sound.ts"
import {
  WORKSPACE_CLOSED_ACTIVE_BACKGROUND,
  WORKSPACE_CLOSED_CHROME_BACKGROUND,
} from "../components/workspace-chrome.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"

interface TestPanel {
  root: BoxRenderable
  keys: KeyEvent[]
  openedQuestions: string[]
  openedPermissions: string[]
  openedSessions: string[]
  dismissedNotifications: string[]
  marketStates: Array<boolean | null>
  interrupts: string[]
  handleKey(key: KeyEvent): void
  capturesInput(): boolean
  clearInputOnInterrupt(): boolean
  openQuestion(sessionId: string): void
  openPermission(sessionId: string): void
  openSession(sessionId: string): void
  dismissNotification(notificationId: string): void
  isShowingSession(sessionId: string): boolean
  hasEmbeddedChat(): boolean
  setMarketOpen(open: boolean | null): void
  destroy(): void
}

/**
 * A panel, near enough for the workspace to be driven against.
 *
 * `capturesInput` is the only thing the workspace asks of a panel beyond drawing
 * itself, so a fake that answers it exercises the tab shortcuts without a real screen.
 */
function panel(
  renderer: RenderContext,
  label: string,
  options: { capturesInput?: boolean; clearsInput?: boolean; showingSession?: string; embeddedChat?: boolean } = {},
): TestPanel {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%" })
  root.add(new TextRenderable(renderer, { content: label }))
  const keys: KeyEvent[] = []
  const openedQuestions: string[] = []
  const openedPermissions: string[] = []
  const openedSessions: string[] = []
  const dismissedNotifications: string[] = []
  const marketStates: Array<boolean | null> = []
  const interrupts: string[] = []
  let showingSession = options.showingSession
  return {
    root,
    keys,
    openedQuestions,
    openedPermissions,
    openedSessions,
    dismissedNotifications,
    marketStates,
    interrupts,
    handleKey: (key) => {
      keys.push(key)
    },
    capturesInput: () => options.capturesInput ?? false,
    clearInputOnInterrupt: () => {
      interrupts.push(label)
      return options.clearsInput ?? false
    },
    openQuestion: (sessionId) => {
      openedQuestions.push(sessionId)
      showingSession = sessionId
    },
    openPermission: (sessionId) => {
      openedPermissions.push(sessionId)
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
    hasEmbeddedChat: () => options.embeddedChat ?? false,
    setMarketOpen: (open) => marketStates.push(open),
    destroy: () => {
      if (!root.isDestroyed) root.destroyRecursively()
    },
  }
}

function rgba(color: string): [number, number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    255,
  ]
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

function permission(id: string): ChatPermissionRequest {
  return {
    id,
    sessionId: `chat-${id}`,
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100 (LIMIT)",
    reason: null,
    scope: "SESSION",
    createdAt: 1_000,
  }
}

async function mountWorkspace(options: { capturesInput?: boolean; clearsInput?: boolean; showingSession?: string } = {}) {
  const harness = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL", {
    capturesInput: options.capturesInput,
    clearsInput: options.clearsInput,
  })
  const chat = panel(harness.renderer, "CHAT PANEL", options)
  const logs = panel(harness.renderer, "LOG PANEL", {
    capturesInput: options.capturesInput,
    clearsInput: options.clearsInput,
  })
  const workspace = new TradingWorkspaceScreen(harness.renderer, { trade, chat, logs })
  harness.renderer.root.add(workspace.root)
  workspace.mount()
  return { ...harness, workspace, trade, chat, logs }
}

test("delegates interrupt clearing to the active panel and shows quit confirmation", async () => {
  const { renderer, renderOnce, captureCharFrame, workspace, trade, chat } = await mountWorkspace({ clearsInput: true })

  expect(workspace.clearInputOnInterrupt()).toBe(true)
  expect(trade.interrupts).toEqual(["TRADE PANEL"])
  expect(chat.interrupts).toBeEmpty()

  workspace.setQuitConfirmation(true)
  await renderOnce()
  expect(captureCharFrame()).toContain("Press Ctrl+C again to quit.")
  workspace.setQuitConfirmation(false)
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Press Ctrl+C again to quit.")

  workspace.selectTab("chat")
  expect(workspace.clearInputOnInterrupt()).toBe(true)
  expect(chat.interrupts).toEqual(["CHAT PANEL"])

  workspace.destroy()
  renderer.destroy()
})

test("switches tabs on click without selecting their labels", async () => {
  const { renderer, mockMouse, waitForFrame, workspace } = await mountWorkspace()
  const frame = await waitForFrame((value) => value.includes("TRADE PANEL"))
  const lines = frame.split("\n")
  const tabsY = lines.findIndex((line) => line.includes("TRADE") && line.includes("CHAT"))
  const chatX = lines[tabsY]?.indexOf("CHAT") ?? -1

  await mockMouse.click(chatX, tabsY)
  await waitForFrame((value) => value.includes("CHAT PANEL"))
  expect(renderer.getSelection()).toBeNull()

  workspace.destroy()
  renderer.destroy()
})

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

test("dims the workspace chrome and every panel footer when the market closes", async () => {
  const { renderer, renderOnce, captureSpans, workspace, trade, chat, logs } = await mountWorkspace()

  workspace.setMarketOpen(false)
  await renderOnce()

  const backgrounds = captureSpans().lines[0]?.spans.map((span) => span.bg.toInts()) ?? []
  expect(backgrounds).toContainEqual(rgba(WORKSPACE_CLOSED_CHROME_BACKGROUND))
  expect(backgrounds).toContainEqual(rgba(WORKSPACE_CLOSED_ACTIVE_BACKGROUND))
  expect(trade.marketStates).toEqual([false])
  expect(chat.marketStates).toEqual([false])
  expect(logs.marketStates).toEqual([false])

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
  workspace.notifyQuestion(request)
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

  workspace.notifyQuestion(question("one"))
  workspace.notifyQuestion(question("two"))
  workspace.notifyQuestion(question("two"))
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

  workspace.notifyQuestion(question("one"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Agent needs your answer")

  workspace.selectTab("trade")
  await waitForFrame((frame) => frame.includes("Agent needs your answer") && frame.includes("How should one continue?"))

  workspace.destroy()
  renderer.destroy()
})

test("keeps a question inline while its embedded trade chat is visible", async () => {
  const harness = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL", { showingSession: "chat-one" })
  const chat = panel(harness.renderer, "CHAT PANEL")
  const logs = panel(harness.renderer, "LOG PANEL")
  const workspace = new TradingWorkspaceScreen(harness.renderer, { trade, chat, logs })
  harness.renderer.root.add(workspace.root)
  workspace.mount()

  workspace.notifyQuestion(question("one"))
  await harness.renderOnce()
  expect(harness.captureCharFrame()).not.toContain("Agent needs your answer")

  workspace.selectTab("logs")
  await harness.waitForFrame((frame) => frame.includes("Agent needs your answer"))

  workspace.destroy()
  harness.renderer.destroy()
})

test("a permission notice sounds and opens its originating chat", async () => {
  const harness = await createTestRenderer({ width: 90, height: 24, kittyKeyboard: true })
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

  workspace.notifyPermission(permission("one"))
  await harness.waitForFrame((frame) => frame.includes("Agent needs tool permission") && frame.includes("Review"))
  harness.mockInput.pressEnter()
  await harness.waitForFrame((frame) => frame.includes("CHAT PANEL") && !frame.includes("Agent needs tool permission"))

  expect(chat.openedPermissions).toEqual(["chat-one"])
  expect(cues).toEqual(["PERMISSION"])
  workspace.destroy()
  harness.renderer.destroy()
})

test("agent notifications use the main chat when the trade-side chat is hidden", async () => {
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

test("an agent notification stays on trade and opens its embedded chat", async () => {
  const harness = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL", {
    embeddedChat: true,
    showingSession: "chat-current",
  })
  const chat = panel(harness.renderer, "CHAT PANEL")
  const logs = panel(harness.renderer, "LOG PANEL")
  const workspace = new TradingWorkspaceScreen(harness.renderer, { trade, chat, logs })
  harness.renderer.root.add(workspace.root)
  workspace.mount()

  workspace.notifyAgent(notification("one"))
  await harness.waitForFrame((frame) => frame.includes("Notice one"))
  harness.mockInput.pressEnter()
  const frame = await harness.waitForFrame((value) => value.includes("TRADE PANEL") && !value.includes("Notice one"))

  expect(frame).not.toContain("CHAT PANEL")
  expect(trade.openedSessions).toEqual(["chat-one"])
  expect(chat.openedSessions).toEqual([])
  expect(chat.dismissedNotifications).toEqual(["one"])

  workspace.destroy()
  harness.renderer.destroy()
})
