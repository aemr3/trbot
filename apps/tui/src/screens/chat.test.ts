import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { chatBlockText, type ChatMessage, type ChatSession, type ChatSessionDetail } from "@trbot/chat/session.ts"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { ChatPermissionReply, ChatPermissionRequest } from "@trbot/chat/permission.ts"
import { ChatLoopSchema, type ChatAutomationState } from "@trbot/chat/automation.ts"
import { createMarketMonitor } from "@trbot/market/market-monitor.ts"
import type { AiAccount, AiModelChoice, AiModelSummary, AiPreferences, AiProviderSummary } from "@trbot/protocol/ai.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import type { SoundCue } from "../components/sound.ts"
import { ApplicationLog } from "../logging/application-log.ts"
import { ChatScreen } from "./chat.ts"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"

/** A server-side chat, near enough for a screen to be driven against. */
function fakeChats(): ChatSessions & {
  sessions: ChatSession[]
  messages: Map<string, ChatMessage[]>
  sent: string[]
  cancelled: string[]
  aborted: string[]
  compacted: string[]
  undone: Array<{ sessionId: string; messageId: string }>
  answered: Array<{ requestId: string; answers: ChatQuestionAnswer[] }>
  rejected: string[]
  agentNotifications: ChatNotification[]
  dismissedNotifications: string[]
  permissionDecisions: Array<{ requestId: string; reply: ChatPermissionReply }>
  mobilePairings: string[]
  disconnectedMobile: string[]
} {
  const sessions: ChatSession[] = []
  const messages = new Map<string, ChatMessage[]>()
  const sent: string[] = []
  const cancelled: string[] = []
  const aborted: string[] = []
  const compacted: string[] = []
  const undone: Array<{ sessionId: string; messageId: string }> = []
  const answered: Array<{ requestId: string; answers: ChatQuestionAnswer[] }> = []
  const rejected: string[] = []
  const agentNotifications: ChatNotification[] = []
  const dismissedNotifications: string[] = []
  const permissionDecisions: Array<{ requestId: string; reply: ChatPermissionReply }> = []
  const mobilePairings: string[] = []
  const disconnectedMobile: string[] = []
  const automations = new Map<string, ChatAutomationState>()

  return {
    sessions,
    messages,
    sent,
    cancelled,
    aborted,
    compacted,
    undone,
    answered,
    rejected,
    agentNotifications,
    dismissedNotifications,
    permissionDecisions,
    mobilePairings,
    disconnectedMobile,
    async list() {
      // A copy, as a real client's answer would be: handing out the live array
      // would let the screen and the fake share state no server ever shares.
      return sessions.filter((session) => session.parentSessionId === null)
    },
    async children(sessionId) {
      return sessions.filter((session) => session.parentSessionId === sessionId)
    },
    async create(choice?: AiModelChoice) {
      const session: ChatSession = {
        id: `chat-${sessions.length + 1}`,
        title: "New chat",
        parentSessionId: null,
        agent: null,
        model: choice?.modelId ?? "test-model",
        provider: choice?.providerId ?? "test-provider",
        reasoning: choice?.reasoning ?? null,
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
    async configure(sessionId, choice) {
      const session = sessions.find((entry) => entry.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      session.provider = choice.providerId
      session.model = choice.modelId
      session.reasoning = choice.reasoning
      return { ...session }
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
    async previewUndo(sessionId, messageId) {
      const message = (messages.get(sessionId) ?? []).find((entry) => entry.id === messageId)
      if (!message) throw new Error("no such message")
      return { prompt: message.text, effects: [] }
    },
    async undo(sessionId, messageId) {
      undone.push({ sessionId, messageId })
      const transcript = messages.get(sessionId) ?? []
      const index = transcript.findIndex((message) => message.id === messageId)
      if (index < 0) throw new Error("no such message")
      const removed = transcript.splice(index)
      const session = sessions.find((entry) => entry.id === sessionId)
      if (session) session.messageCount = transcript.length
      return {
        prompt: removed[0]!.text,
        removedMessageIds: removed.map((message) => message.id),
        revertedEffects: [],
        preservedEffects: [],
      }
    },
    async abort(sessionId) {
      aborted.push(sessionId)
    },
    async compact(sessionId) {
      compacted.push(sessionId)
      return {
        compacted: true,
        tokensBefore: 24_000,
      }
    },
    async mobile(_sessionId) {
      return { available: true, connection: null }
    },
    async connectMobile(sessionId) {
      mobilePairings.push(sessionId)
      return {
        channel: "telegram" as const,
        url: "https://t.me/trbot_test_bot?start=pairing-token",
        expiresAt: Date.now() + 300_000,
      }
    },
    async disconnectMobile(sessionId) {
      disconnectedMobile.push(sessionId)
    },
    async automations(sessionId) {
      return automations.get(sessionId) ?? { goal: null, loops: [] }
    },
    async createGoal(sessionId, input) {
      const now = 1_000
      const goal = {
        id: "goal-1",
        sessionId,
        objective: input.objective,
        status: "ACTIVE" as const,
        turnCount: 0,
        maxTurns: input.maxTurns ?? 50,
        tokenBudget: input.tokenBudget ?? null,
        startedTokens: 0,
        usedTokens: 0,
        lastEvaluation: null,
        pendingEventKey: null,
        createdAt: now,
        updatedAt: now,
      }
      automations.set(sessionId, { goal, loops: automations.get(sessionId)?.loops ?? [] })
      return goal
    },
    async updateGoal(sessionId, input) {
      const state = automations.get(sessionId) ?? { goal: null, loops: [] }
      if (input.action === "CLEAR") {
        automations.set(sessionId, { ...state, goal: null })
        return null
      }
      if (!state.goal) throw new Error("no goal")
      const goal = { ...state.goal, status: input.action === "PAUSE" ? "PAUSED" as const : "ACTIVE" as const }
      automations.set(sessionId, { ...state, goal })
      return goal
    },
    async createLoop(sessionId, input) {
      const state = automations.get(sessionId) ?? { goal: null, loops: [] }
      const intervalMs = input.schedule === "INTERVAL"
        ? input.intervalMs
        : input.schedule === "DYNAMIC"
          ? input.initialDelayMs ?? 60_000
          : null
      const nextRunAt = input.schedule === "ONCE" ? input.runAt : 1_000 + (intervalMs ?? 60_000)
      const loop = ChatLoopSchema.parse({
        id: `loop-${state.loops.length + 1}`,
        sessionId,
        prompt: input.prompt ?? "Maintenance",
        usesDefaultPrompt: input.prompt === undefined,
        schedule: input.schedule,
        intervalMs,
        cronExpression: input.schedule === "CRON" ? input.cronExpression : null,
        status: "ACTIVE" as const,
        nextRunAt,
        lastRunAt: null,
        runCount: 0,
        maxRuns: input.maxRuns ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      state.loops.push(loop)
      automations.set(sessionId, state)
      return loop
    },
    async cancelLoop(sessionId, loopId) {
      const state = automations.get(sessionId) ?? { goal: null, loops: [] }
      automations.set(sessionId, { ...state, loops: state.loops.filter((loop) => loop.id !== loopId) })
    },
    async questions() {
      return []
    },
    async answerQuestion(requestId, answers) {
      answered.push({ requestId, answers })
    },
    async rejectQuestion(requestId) {
      rejected.push(requestId)
    },
    async permissions() {
      return []
    },
    async answerPermission(requestId, reply) {
      permissionDecisions.push({ requestId, reply })
    },
    async notifications() {
      return [...agentNotifications]
    },
    async dismissNotification(notificationId) {
      dismissedNotifications.push(notificationId)
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
    model: null,
    reasoning: null,
    elapsedMs: null,
    thinkingMs: null,
    createdAt: 1_000,
  }
}

function replyMessage(text: string, status: ChatMessage["status"] = "COMPLETE"): ChatMessage {
  return {
    ...userMessage(text, status),
    id: `reply-${text}`,
    role: "ASSISTANT",
    model: "test-model",
    reasoning: "high",
  }
}

function toolResultMessage(toolName: string, text: string): ChatMessage {
  return {
    ...userMessage(text, "COMPLETE"),
    id: `tool-result-${toolName}-${text}`,
    role: "TOOL_RESULT",
    toolName,
    toolCallId: `call-${toolName}`,
  }
}

function applicationEvent(text: string): ChatMessage {
  return {
    ...userMessage(text, "SENT"),
    id: `event-${text}`,
    role: "APP_EVENT",
  }
}

/**
 * The providers as a server would report them.
 *
 * `connected` decides whether the screen offers a composer at all, which is the
 * gate these tests are mostly about.
 */
function account(options: {
  connected?: boolean
  models?: AiModelSummary[]
  preferences?: AiPreferences
  onSetPreferences?: (preferences: AiPreferences) => void
} = {}): AiAccount {
  let joined = options.connected ?? false
  let preferences: AiPreferences = options.preferences ?? { chat: null }
  const summary = (): AiProviderSummary => ({
    providerId: "test-provider",
    name: "Test Provider",
    authTypes: ["api_key"],
    isSubscription: false,
    connected: joined,
    source: joined ? "stored credential" : null,
    accountId: null,
    connectedAt: joined ? 1 : null,
    updatedAt: joined ? 1 : null,
  })
  return {
    async providers() {
      return [summary()]
    },
    async models() {
      return options.models ?? [{
        providerId: "test-provider",
        providerName: "Test Provider",
        modelId: "test-model",
        name: "Test Model",
        reasoning: true,
        thinkingLevels: ["low", "high"],
        contextWindow: 128_000,
      }]
    },
    async connect() {
      joined = true
      return summary()
    },
    async disconnect() {
      joined = false
    },
    async preferences() {
      return preferences
    },
    async setPreferences(next) {
      preferences = next
      options.onSetPreferences?.(preferences)
      return preferences
    },
  }
}

/** Shorthand for the common case: something connected and usable. */
const connected = { connected: true }

/**
 * Keys as the terminal really delivers them.
 *
 * A live renderer hands a key to the screen and then to whichever renderable holds
 * focus, unless the screen marks it handled. The test renderer keeps those two paths on
 * separate emitters, so a screen that lets a focused field see the key twice looks fine
 * under the plain wiring and doubles every character in a terminal.
 */
function routeKeys(renderer: RenderContext & { keyInput: { on(event: "keypress", handler: (key: KeyEvent) => void): void } }, screen: { handleKey(key: KeyEvent): void }): void {
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    screen.handleKey(key)
    const focused = renderer.currentFocusedRenderable
    if (!key.defaultPrevented) focused?.handleKeyPress?.(key)
  })
}

test("asks the trader to connect a provider before offering a composer", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const screen = new ChatScreen(renderer, { chats: fakeChats(), account: account(), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))

  // Nothing to type into while nothing is connected: the instruction is the only
  // thing on offer.
  const gate = await waitForFrame((frame) => frame.includes("No model provider connected"))
  expect(gate).not.toContain("ask something")

  mockInput.pressEnter()
  // Every provider the harness offers is listed, connected or not.
  await waitForFrame((frame) => frame.includes("Model providers"))
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("connected."))
  mockInput.pressEscape()
  // Connecting in the modal is what opens the chat, without leaving the tab.
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.destroy()
  renderer.destroy()
})

test("sends what is typed and shows it waiting its turn", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
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
  expect(queued).toContain("^X cancels it")

  screen.destroy()
  renderer.destroy()
})

test("answers an agent question and returns to the composer", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  const request: ChatQuestionRequest = {
    id: "question-1",
    sessionId: session.id,
    questions: [{
      header: "Strategy",
      question: "Which setup should I watch?",
      options: [
        { label: "Breakout", description: "Wait for resistance to break" },
        { label: "Pullback", description: "Wait for a retracement" },
      ],
    }],
  }
  screen.acceptQuestion(request)
  await waitForFrame((frame) => frame.includes("Which setup should I watch?"))

  mockInput.pressArrow("down")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("ask something") && !frame.includes("Which setup should I watch?"))

  expect(chats.answered).toEqual([{ requestId: "question-1", answers: [["Pullback"]] }])
  expect(chats.rejected).toEqual([])
  screen.destroy()
  renderer.destroy()
})

test("leaves an inline agent question pending and answers it later", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptQuestion({
    id: "question-2",
    sessionId: session.id,
    questions: [{ header: "Confirm", question: "Continue?", options: [] }],
  })
  await waitForFrame((frame) => frame.includes("Continue?"))
  mockInput.pressTab()
  await waitForFrame((frame) => frame.includes("Continue?") && frame.includes("Tab to answer"))
  mockInput.pressTab()
  mockInput.pressEnter()
  await mockInput.typeText("Yes")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("ask something") && !frame.includes("Continue?"))

  expect(chats.answered).toEqual([{ requestId: "question-2", answers: [["Yes"]] }])
  expect(chats.rejected).toEqual([])
  expect(chats.sent).toEqual([])
  screen.destroy()
  renderer.destroy()
})

test("freezes the composer while a trading permission is pending", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  const request: ChatPermissionRequest = {
    id: "permission-1",
    sessionId: session.id,
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100 (LIMIT)",
    reason: "Open the planned position",
    scope: "SESSION",
    createdAt: 1_000,
  }
  screen.acceptPermission(request)
  const blocked = await waitForFrame((frame) => frame.includes("Permission required"))
  expect(blocked).not.toContain("ask something")

  await mockInput.typeText("this must not enter the composer")
  await Bun.sleep(0)
  expect(chats.sent).toEqual([])

  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("ask something") && !frame.includes("Permission required"))
  expect(chats.permissionDecisions).toEqual([{
    requestId: request.id,
    reply: { decision: "ALLOW", scope: "SESSION" },
  }])

  screen.destroy()
  renderer.destroy()
})

test("dismisses a question notification on trade and answers it later in chat", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  let workspace: TradingWorkspaceScreen | null = null
  const chat = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    onQuestionPending: (request) => workspace?.notifyQuestion(request),
    onQuestionResolved: (requestId) => workspace?.resolveQuestion(requestId),
  })
  workspace = new TradingWorkspaceScreen(renderer, {
    trade: labelledPanel(renderer, "TRADE PANEL"),
    chat,
    logs: labelledPanel(renderer, "LOG PANEL"),
  })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  chat.acceptQuestion({
    id: "question-away",
    sessionId: session.id,
    questions: [{
      header: "Risk",
      question: "Should I keep watching this position?",
      options: [{ label: "Keep watching", description: "Leave the monitor active" }],
    }],
  })
  await waitForFrame((frame) => frame.includes("Agent needs your answer") && frame.includes("Open chat"))

  mockInput.pressEscape()
  const stayed = await waitForFrame((frame) => frame.includes("TRADE PANEL") && !frame.includes("Agent needs your answer"))
  expect(stayed).not.toContain("Should I keep watching this position?")

  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Should I keep watching this position?") && frame.includes("Agent asks · Risk"))
  mockInput.pressEnter()
  await waitForFrame((frame) => !frame.includes("Should I keep watching this position?"))

  expect(chats.answered).toEqual([{ requestId: "question-away", answers: [["Keep watching"]] }])
  workspace.destroy()
  renderer.destroy()
})

test("restores durable agent notifications when the chat screen mounts", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const notification: ChatNotification = {
    id: "notice-1",
    sessionId: session.id,
    title: "Review complete",
    message: "The setup remains valid.",
    urgency: "INFO",
    createdAt: 1_000,
  }
  chats.agentNotifications.push(notification)
  const restored: ChatNotification[] = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    onNotification: (notice) => restored.push(notice),
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitFor(() => restored.length === 1)

  expect(restored).toEqual([notification])
  screen.destroy()
  renderer.destroy()
})

test("renders a reply as it streams and replaces it with the stored message", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
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

test("keeps only the newest 100 top-level events in the live transcript", async () => {
  const { renderer, waitForFrame, waitFor } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  for (let index = 0; index <= 100; index++) {
    screen.acceptMessage(session.id, replyMessage(`answer ${index}`))
  }
  await waitFor(() => screen.root.findDescendantById("turn-99") !== undefined)

  expect(screen.root.findDescendantById("turn-100")).toBeUndefined()
  screen.destroy()
  renderer.destroy()
})

test("removes completed tools from the live status list", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptDelta(session.id, "run-1", { toolName: "get_quote" })
  screen.acceptDelta(session.id, "run-1", { toolName: "get_candles" })
  await waitForFrame((frame) => frame.includes("⚙ get_quote") && frame.includes("⚙ get_candles"))

  screen.acceptMessage(session.id, toolResultMessage("get_quote", "Read live quote."))
  const oneRunning = await waitForFrame((frame) => frame.includes("Read live quote.") && !frame.includes("⚙ get_quote"))
  expect(oneRunning).toContain("⚙ get_candles")

  screen.acceptMessage(session.id, toolResultMessage("get_candles", "Read candles."))
  const completed = await waitForFrame((frame) => frame.includes("Read candles.") && !frame.includes("⚙ get_candles"))
  expect(completed).toContain("thinking…")

  screen.destroy()
  renderer.destroy()
})

test("renders a market-monitor wake-up as an application event, not as user input", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, applicationEvent("ASELS crossed above 420 at 421."))
  const frame = await waitForFrame((value) => value.includes("ASELS crossed above 420 at 421."))

  expect(frame).toContain("◆ market monitor")
  expect(frame).not.toContain("› ASELS crossed")
  screen.destroy()
  renderer.destroy()
})

test("opens a filtered slash-command menu below the composer", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/")
  const menu = await waitForFrame((frame) => frame.includes("/model") && frame.includes("/sessions"))
  expect(menu).toContain("/clear")
  expect(menu).toContain("/undo")
  expect(menu).not.toContain("/rewind")
  expect(menu).not.toContain("/checkpoint")
  expect(menu).not.toContain("/chats")
  const lines = menu.split("\n")
  const composerRow = lines.findIndex((line) => line.includes("› /"))
  const firstCommand = lines.findIndex((line) => line.includes("/model"))
  expect(composerRow).toBeGreaterThanOrEqual(0)
  expect(firstCommand).toBeGreaterThan(composerRow)

  await mockInput.typeText("sub")
  const filtered = await waitForFrame((frame) => frame.includes("/subagents") && !frame.includes("/model"))
  expect(filtered).toContain("open this chat's worker sessions")

  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("No subagents have run in this session."))
  expect(chats.sent).toEqual([])

  screen.destroy()
  renderer.destroy()
})

test("offers disconnect instead of connect for a Telegram-linked session", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 36,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  const session = await chats.create()
  let mobileConnected = true
  chats.mobile = async (sessionId) => ({
    available: true,
    connection: mobileConnected
      ? { sessionId, channel: "telegram", displayName: "@ada", connectedAt: 1_000 }
      : null,
  })
  chats.disconnectMobile = async (sessionId) => {
    chats.disconnectedMobile.push(sessionId)
    mobileConnected = false
  }
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/")
  const connectedMenu = await waitForFrame((frame) => frame.includes("/disconnect"))
  expect(connectedMenu).not.toContain("/connect ")

  await mockInput.typeText("disconnect")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Disconnected from Telegram."))
  expect(chats.disconnectedMobile).toEqual([session.id])

  await mockInput.typeText("/")
  const disconnectedMenu = await waitForFrame((frame) => frame.includes("/connect"))
  expect(disconnectedMenu).not.toContain("/disconnect")

  screen.destroy()
  renderer.destroy()
})

test("saves an empty chat before connecting it to Telegram", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 36,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  let pairingStarted = false
  chats.mobile = async (sessionId) => ({
    available: true,
    connection: pairingStarted
      ? { sessionId, channel: "telegram", displayName: "@ada", connectedAt: 1_000 }
      : null,
  })
  chats.connectMobile = async (sessionId) => {
    chats.mobilePairings.push(sessionId)
    pairingStarted = true
    return {
      channel: "telegram",
      url: "https://t.me/trbot_test_bot?start=pairing-token",
      expiresAt: Date.now() + 300_000,
    }
  }
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialSessionId: null,
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("New chat"))

  await mockInput.typeText("/")
  const emptyMenu = await waitForFrame((frame) => frame.includes("/model") && frame.includes("/providers"))
  expect(emptyMenu).toContain("/connect")
  expect(emptyMenu).not.toContain("/disconnect")

  await mockInput.typeText("connect")
  mockInput.pressEnter()
  const connectedFrame = await waitForFrame((frame) => frame.includes("Connected to Telegram · @ada"))
  expect(chats.sessions).toHaveLength(1)
  expect(chats.mobilePairings).toEqual(["chat-1"])
  expect(screen.hasOpenModal()).toBe(false)
  expect(connectedFrame).not.toContain("Scan with your phone")

  screen.destroy()
  renderer.destroy()
})

test("/clear and /new wait for a prompt before creating the next session", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const saved = await chats.create()
  await chats.send(saved.id, "saved conversation")
  const selections: Array<string | null> = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    onSessionChange: (sessionId) => selections.push(sessionId),
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("saved conversation"))

  for (const [command, prompt] of [["/clear", "fresh after clear"], ["/new", "fresh after new"]] as const) {
    const sessionCount = chats.sessions.length
    await mockInput.typeText(command)
    mockInput.pressEnter()
    const empty = await waitForFrame((frame) => (
      frame.includes("New chat")
      && frame.includes("Ask about a market")
      && !frame.includes(prompt)
    ))
    expect(empty).not.toContain("No chat yet")
    expect(empty).toContain("commands")
    expect(empty).toContain("sessions")
    expect(chats.sessions).toHaveLength(sessionCount)
    expect(selections.at(-1)).toBeNull()

    // A server refresh must not reopen the saved chat while the blank state is active.
    screen.acceptSessions([...chats.sessions])
    await waitForFrame((frame) => frame.includes("New chat") && !frame.includes("saved conversation"))
    expect(selections.at(-1)).toBeNull()

    await mockInput.typeText(prompt)
    mockInput.pressEnter()
    await waitForFrame((frame) => frame.includes(prompt))
    expect(chats.sessions).toHaveLength(sessionCount + 1)
  }

  expect(chats.sessions.map((session) => session.id)).toEqual(["chat-1", "chat-2", "chat-3"])
  expect(chats.sent).toEqual(["saved conversation", "fresh after clear", "fresh after new"])

  const sessionCount = chats.sessions.length
  await mockInput.typeText("draft to discard")
  mockInput.pressKey("n", { ctrl: true })
  const shortcut = await waitForFrame((frame) => frame.includes("New chat") && !frame.includes("draft to discard"))
  expect(shortcut).toContain("Ask about a market")
  expect(chats.sessions).toHaveLength(sessionCount)

  screen.destroy()
  renderer.destroy()
})

test("opens undo with Esc Esc or /undo and restores the chosen prompt", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const first = userMessage("first question", "SENT")
  const second = { ...userMessage("second question", "SENT"), id: "message-second" }
  chats.messages.set(session.id, [first, replyMessage("first answer"), second, replyMessage("second answer")])
  session.messageCount = 4
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("second answer"))

  mockInput.pressEscape()
  mockInput.pressEscape()
  const shortcut = await waitForFrame((frame) => frame.includes("Restore the conversation to the point before"))
  expect(shortcut).toContain("second question")
  expect(shortcut).toContain("first question")
  expect(shortcut).not.toContain("╭")
  const shortcutLines = shortcut.split("\n")
  const hintLine = shortcutLines.findIndex((line) => line.includes("Enter to continue"))
  const statusLine = shortcutLines.findLastIndex((line) => line.includes("test-model"))
  expect(statusLine - hintLine).toBe(2)
  expect(screen.hasOpenModal()).toBe(false)
  mockInput.pressEscape()
  await waitForFrame((frame) => !frame.includes("Restore the conversation to the point before"))

  await mockInput.typeText("/undo")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Restore the conversation to the point before"))
  mockInput.pressArrow("up")
  mockInput.pressEnter()
  const confirmation = await waitForFrame((frame) => frame.includes("Undo this message?"))
  expect(confirmation).toContain("Conversation only")
  expect(confirmation).toContain("Conversation + reversible actions")
  mockInput.pressEnter()

  const restored = await waitForFrame((frame) => frame.includes("Conversation undone"))
  expect(restored).toContain("second question")
  expect(restored).toContain("first answer")
  expect(restored).not.toContain("second answer")
  expect(chats.undone).toEqual([{ sessionId: session.id, messageId: second.id }])

  screen.destroy()
  renderer.destroy()
})

test("clicking a completed prompt opens its undo confirmation before rewinding", async () => {
  const { renderer, mockInput, mockMouse, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  const session = await chats.create()
  const prompt = userMessage("what should we trade on monday", "SENT")
  chats.messages.set(session.id, [prompt, replyMessage("Reviewing the setup.")])
  session.messageCount = 2
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)

  const initial = await waitForFrame((frame) => frame.includes(prompt.text))
  const promptLine = initial.split("\n").findIndex((line) => line.includes(prompt.text))
  const promptColumn = initial.split("\n")[promptLine]?.indexOf(prompt.text) ?? -1
  await mockMouse.click(promptColumn + 2, promptLine)

  const confirmation = await waitForFrame((frame) => frame.includes("Undo this message?"))
  expect(confirmation).toContain("Message actions")
  expect(confirmation).toContain("Conversation only")
  expect(confirmation).toContain("Conversation + reversible actions")
  expect(confirmation).toContain("Esc to cancel")
  expect(confirmation).toContain("╭")
  expect(confirmation).not.toContain("Restore the conversation to the point before")
  expect(screen.hasOpenModal()).toBe(true)
  expect(chats.undone).toEqual([])

  mockInput.pressEscape()
  await waitForFrame((frame) => !frame.includes("Undo this message?") && frame.includes(prompt.text))
  expect(screen.hasOpenModal()).toBe(false)
  expect(chats.undone).toEqual([])

  await mockMouse.click(promptColumn + 2, promptLine)
  await waitForFrame((frame) => frame.includes("Undo this message?"))
  mockInput.pressEnter()
  await Bun.sleep(0)
  await waitForFrame((frame) => frame.includes("Conversation undone"))
  expect(chats.undone).toEqual([{ sessionId: session.id, messageId: prompt.id }])

  screen.destroy()
  renderer.destroy()
})

test("restores a saved new-chat state and shows the model its first prompt will use", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const saved = await chats.create()
  await chats.send(saved.id, "older saved chat")
  const selections: Array<string | null> = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account({
      connected: true,
      preferences: {
        chat: { providerId: "test-provider", modelId: "test-model", reasoning: "high" },
      },
    }),
    logs: new ApplicationLog(),
    initialSessionId: null,
    onSessionChange: (sessionId) => selections.push(sessionId),
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)

  const restored = await waitForFrame((frame) => (
    frame.includes("New chat")
    && frame.includes("test-model")
    && frame.includes("high")
  ))
  expect(restored).not.toContain("older saved chat")
  expect(selections).toBeEmpty()

  screen.acceptSessions([...chats.sessions])
  await waitForFrame((frame) => frame.includes("New chat") && !frame.includes("older saved chat"))
  expect(selections).toBeEmpty()

  await mockInput.typeText("first prompt after restart")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("first prompt after restart"))
  expect(chats.sessions).toHaveLength(2)
  expect(chats.sessions[1]).toMatchObject({
    model: "test-model",
    provider: "test-provider",
    reasoning: "high",
  })
  expect(selections).toEqual(["chat-2"])

  screen.destroy()
  renderer.destroy()
})

test("wraps slash-command descriptions within a narrow chat panel", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 46, height: 18, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/mon")
  const menu = await waitForFrame((frame) => frame.includes("/monitors") && frame.includes("market monitors"))
  const lines = menu.split("\n")
  const commandRow = lines.findIndex((line) => line.includes("/monitors"))
  const continuationRow = lines.findIndex((line, index) => index > commandRow && line.includes("market monitors"))
  expect(commandRow).toBeGreaterThanOrEqual(0)
  expect(continuationRow).toBe(commandRow + 1)
  expect(lines[continuationRow]?.indexOf("market monitors")).toBeGreaterThan(lines[commandRow]?.indexOf("/monitors") ?? 0)

  screen.destroy()
  renderer.destroy()
})

test("centers embedded chat modals over their full host", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const host = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "row" })
  host.add(new BoxRenderable(renderer, { width: 60, height: "100%" }))
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  screen.setModalHost(host)
  host.add(screen.root)
  renderer.root.add(host)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/help")
  mockInput.pressEnter()
  const modal = await waitForFrame((frame) => frame.includes("Keys") && frame.includes("Esc close"))
  const border = modal.split("\n").find((line) => line.includes("╭"))
  expect(border?.indexOf("╭")).toBe(20)

  screen.destroy()
  renderer.destroy()
})

test("matches the trade side-panel background when embedded", async () => {
  const { renderer, mockInput, waitForFrame, captureSpans } = await createTestRenderer({
    width: 50,
    height: 24,
    kittyKeyboard: true,
  })
  const screen = new ChatScreen(renderer, {
    chats: fakeChats(),
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
    initialSessionId: null,
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("New chat") && frame.includes("ask something"))

  const expectedBackground: [number, number, number, number] = [22, 22, 22, 255]
  for (const text of ["New chat", "ask something"]) {
    const span = captureSpans().lines
      .flatMap((line) => line.spans)
      .find((candidate) => candidate.text.includes(text))
    expect(span?.bg.toInts()).toEqual(expectedBackground)
  }

  await mockInput.typeText("/")
  await waitForFrame((frame) => frame.includes("/model"))
  const command = captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes("/model"))
  expect(command?.bg.toInts()).toEqual(expectedBackground)

  screen.destroy()
  renderer.destroy()
})

test("matches the trade side-panel background for embedded rewind", async () => {
  const { renderer, waitForFrame, captureSpans } = await createTestRenderer({
    width: 50,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  const session = await chats.create()
  const prompt = userMessage("review monday", "SENT")
  chats.messages.set(session.id, [prompt, replyMessage("reviewed")])
  session.messageCount = 2
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("reviewed"))

  screen.openUndo()
  await waitForFrame((frame) => frame.includes("Rewind") && frame.includes("review monday"))

  const rewind = captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes("Rewind"))
  expect(rewind?.bg.toInts()).toEqual([22, 22, 22, 255])

  screen.destroy()
  renderer.destroy()
})

test("dims the composer and earlier user messages while stock futures are closed", async () => {
  const { renderer, waitForFrame, waitFor, captureSpans } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))
  screen.acceptMessage(session.id, userMessage("earlier question", "SENT"))
  await waitForFrame((frame) => frame.includes("earlier question"))

  screen.setMarketOpen(false)
  const closedBackground: [number, number, number, number] = [27, 29, 34, 255]
  await waitFor(() => captureSpans().lines.some((line) => (
    line.spans.some((span) => span.text.includes("earlier question"))
      && line.spans.some((span) => span.bg.toInts().every((value, index) => value === closedBackground[index]))
  )))
  for (const text of ["earlier question", "ask something"]) {
    const backgrounds = captureSpans().lines
      .find((line) => line.spans.some((span) => span.text.includes(text)))
      ?.spans.map((span) => span.bg.toInts()) ?? []
    expect(backgrounds).toContainEqual(closedBackground)
  }

  screen.destroy()
  renderer.destroy()
})

test("compacts the selected chat without sending a message", async () => {
  const { renderer, mockInput, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const compacting = Promise.withResolvers<Awaited<ReturnType<ChatSessions["compact"]>>>()
  chats.compact = async (sessionId) => {
    chats.compacted.push(sessionId)
    return await compacting.promise
  }
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/compact")
  mockInput.pressEnter()
  const loading = await waitForFrame((value) => value.includes("Compacting context…"))
  const first = spinnerFrame(loading)
  expect(first).toBeDefined()

  await Bun.sleep(200)
  await renderOnce()
  const second = spinnerFrame(captureCharFrame())
  expect(second).toBeDefined()
  expect(second).not.toBe(first)

  compacting.resolve({ compacted: true, tokensBefore: 24_000 })
  await Bun.sleep(0)
  const frame = await waitForFrame((value) => value.includes("24.0K estimated tokens summarized"))

  expect(frame).toContain("Context compacted")
  expect(spinnerFrame(frame)).toBeUndefined()
  expect(chats.compacted).toEqual([session.id])
  expect(chats.sent).toEqual([])

  screen.destroy()
  renderer.destroy()
})

test("creates and inspects persistent goals and scheduled loops from slash commands", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 110, height: 28, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/goal Verify the close")
  mockInput.pressEnter()
  const goal = await waitForFrame((frame) => frame.includes("active goal") && frame.includes("Verify the close"))
  expect(goal).not.toContain("execution policy")
  expect(chats.sent).toEqual([])

  await mockInput.typeText("/loop 5m Refresh positions")
  mockInput.pressEnter()
  const created = await waitForFrame((frame) => frame.includes("1 loop") && !frame.includes("Scheduled tasks"))
  expect(created).not.toContain("Refresh positions")
  expect(chats.sent).toEqual([])

  await mockInput.typeText("/loop list")
  mockInput.pressEnter()
  const listed = await waitForFrame((frame) => frame.includes("Scheduled tasks") && frame.includes("every 5m"))
  expect(listed).toContain("Refresh positions")

  await mockInput.typeText("/loop Recheck the account every 2 hours")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("2 loops") && !frame.includes("Scheduled tasks"))

  await mockInput.typeText("/loop Watch the open")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("3 loops"))

  await mockInput.typeText("/loop 20s")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("4 loops"))

  await mockInput.typeText("/loop cron */5 * * * * Refresh news")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("5 loops"))

  const state = await chats.automations(session.id)
  expect(state.loops).toEqual(expect.arrayContaining([
    expect.objectContaining({ schedule: "INTERVAL", intervalMs: 300_000, prompt: "Refresh positions" }),
    expect.objectContaining({ schedule: "INTERVAL", intervalMs: 7_200_000, prompt: "Recheck the account" }),
    expect.objectContaining({ schedule: "INTERVAL", intervalMs: 60_000, prompt: "Maintenance" }),
    expect.objectContaining({ schedule: "CRON", cronExpression: "*/5 * * * *", prompt: "Refresh news" }),
  ]))
  const rescheduled = state.loops.find((entry) => entry.schedule === "DYNAMIC" && entry.prompt === "Watch the open")
  if (!rescheduled || rescheduled.schedule !== "DYNAMIC") throw new Error("dynamic loop was not created")
  rescheduled.intervalMs = 3_600_000
  rescheduled.nextRunAt += 3_600_000

  await mockInput.typeText("/loop list")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Scheduled tasks") && frame.includes("Watch the open"))
  screen.acceptMessage(session.id, toolResultMessage("reschedule_loop", "Next run in 60 minutes."))
  const refreshed = await waitForFrame((frame) => frame.includes("5 loops") && !frame.includes("Scheduled tasks"))
  expect(refreshed).not.toContain(rescheduled.id)

  screen.destroy()
  renderer.destroy()
})

test("opens and cancels only the current chat's agent monitors", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 26, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const requested: Array<string | undefined> = []
  const removed: string[] = []
  let monitors = [createMarketMonitor({
    id: "monitor-1",
    instrumentUid: "instrument-1",
    symbol: "F_ASELS0826",
    displayName: "ASELS",
    direction: "ABOVE",
    kind: "PRICE",
    value: 420,
    basis: "TOUCH",
    interval: null,
    repeat: "ONCE",
    referencePrice: 400,
    atrValue: null,
    chatSessionId: session.id,
    onTrigger: "Refresh the quote and reassess the breakout.",
  }, 1_000)]
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    marketMonitors: {
      async list(chatSessionId) {
        requested.push(chatSessionId)
        return chatSessionId
          ? monitors.filter((monitor) => monitor.chatSessionId === chatSessionId)
          : monitors
      },
      async remove(id) {
        removed.push(id)
        monitors = monitors.filter((monitor) => monitor.id !== id)
      },
    },
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something") && frame.includes("1 monitor"))

  await mockInput.typeText("/monitors")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Market monitors") && frame.includes("ASELS"))

  await mockInput.typeText("dd")
  const empty = await waitForFrame((frame) => (
    frame.includes("No open market monitors in this chat.") && !frame.includes("1 monitor")
  ))

  expect(requested.length).toBeGreaterThanOrEqual(3)
  expect(requested.every((chatSessionId) => chatSessionId === session.id)).toBeTrue()
  expect(removed).toEqual(["monitor-1"])
  expect(chats.sent).toEqual([])
  expect(empty).not.toContain("0 monitors")

  screen.destroy()
  renderer.destroy()
})

test("opens durable worker transcripts with /subagents and returns with /parent", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const parent = await chats.create()
  const child: ChatSession = {
    ...parent,
    id: "worker-1",
    title: "Inspect the XU100 trend",
    parentSessionId: parent.id,
    agent: "worker",
    createdAt: 2_000,
    updatedAt: 2_000,
    running: true,
  }
  chats.sessions.push(child)
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("/subagents")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Subagents") && frame.includes("Inspect the XU100 trend"))
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Subagent transcript") && frame.includes("worker · test-model"))

  await mockInput.typeText("/parent")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("/help keys") && !frame.includes("Subagent transcript"))
  expect(chats.sent).toEqual([])

  screen.destroy()
  renderer.destroy()
})

test("keeps the subagent model label intact beside a narrow running hint", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 60, height: 18, kittyKeyboard: true })
  const chats = fakeChats()
  const parent = await chats.create()
  const child: ChatSession = {
    ...parent,
    id: "worker-narrow",
    title: "Inspect the market",
    parentSessionId: parent.id,
    agent: "worker",
    reasoning: "high",
    running: false,
  }
  chats.sessions.push(child)
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialSessionId: child.id,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const idle = await waitForFrame((frame) => frame.includes("⌥←/→ workers") && frame.includes("⌥↑ parent"))
  const idleStatus = idle.split("\n").find((line) => line.includes("worker · test-model")) ?? ""
  expect(idleStatus).toMatch(/worker · test-model · high\s{2,}⌥←\/→ workers · ⌥↑ parent/)

  screen.acceptRun(child.id, "run-narrow", "running")
  const running = await waitForFrame((frame) => frame.includes("Esc interrupt"))
  const runningStatus = running.split("\n").find((line) => line.includes("Esc interrupt")) ?? ""
  expect(runningStatus).toMatch(/worker · test-model · high\s{2,}Esc interrupt · ⌥↑ parent/)
  expect(runningStatus).not.toContain("Subagent running")

  screen.destroy()
  renderer.destroy()
})

test("⌥ arrows cycle worker transcripts directly and return to their parent", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const parent = await chats.create()
  const first: ChatSession = {
    ...parent,
    id: "worker-1",
    title: "First worker",
    parentSessionId: parent.id,
    agent: "worker",
    createdAt: 2_000,
    updatedAt: 2_000,
  }
  const second: ChatSession = {
    ...first,
    id: "worker-2",
    title: "Second worker",
    createdAt: 3_000,
    updatedAt: 3_000,
  }
  chats.sessions.push(first, second)
  const selected: Array<string | null> = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    onSessionChange: (sessionId) => selected.push(sessionId),
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("draft stays here")
  mockInput.pressArrow("right", { meta: true })
  await waitForFrame((frame) => frame.includes("Subagent transcript") && frame.includes("⌥←/→ workers"))
  expect(selected.at(-1)).toBe(first.id)

  mockInput.pressArrow("right", { meta: true })
  await waitForFrame(() => selected.at(-1) === second.id)
  mockInput.pressArrow("left", { meta: true })
  await waitForFrame(() => selected.at(-1) === first.id)
  mockInput.pressArrow("up", { meta: true })
  const parentFrame = await waitForFrame((frame) => (
    selected.at(-1) === parent.id
    && frame.includes("draft stays here")
    && !frame.includes("Subagent transcript")
  ))
  expect(parentFrame).toContain("draft stays here")
  expect(chats.sent).toEqual([])

  screen.destroy()
  renderer.destroy()
})

test("keeps one transcript per session and switches between them", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const first = await chats.create()
  const second = await chats.create()
  const selections: Array<string | null> = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    onSessionChange: (sessionId) => selections.push(sessionId),
  })
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
  const firstTranscript = await waitForFrame((frame) => frame.includes("about ASELS") && !frame.includes("about risk"))
  expect(firstTranscript).not.toContain("ASELS setup")

  // The sessions live in a modal, on a control key so it opens mid-sentence.
  mockInput.pressKey("s", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Risk sizing"))
  mockInput.pressArrow("down")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("about risk") && !frame.includes("about ASELS"))
  expect(selections.at(-1)).toBe(second.id)

  screen.destroy()
  renderer.destroy()
})

test("shows every session's active monitor and loop counts in the sessions modal", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const first = await chats.create()
  const second = await chats.create()
  await chats.createLoop(second.id, {
    schedule: "INTERVAL",
    intervalMs: 60_000,
    prompt: "Review the position.",
  })
  const makeMonitor = (id: string, status: "ARMED" | "PAUSED") => ({
    ...createMarketMonitor({
      id,
      instrumentUid: "instrument-1",
      symbol: "F_ASELS0826",
      displayName: "ASELS",
      direction: "ABOVE",
      kind: "PRICE",
      value: 420,
      basis: "TOUCH",
      interval: null,
      repeat: "ONCE",
      referencePrice: 400,
      atrValue: null,
      chatSessionId: second.id,
      onTrigger: "Refresh the quote.",
    }, 1_000),
    status,
  })
  const monitors = [
    makeMonitor("monitor-1", "ARMED"),
    makeMonitor("monitor-2", "ARMED"),
    makeMonitor("monitor-paused", "PAUSED"),
  ]
  const requests: Array<string | undefined> = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    marketMonitors: {
      async list(chatSessionId) {
        requests.push(chatSessionId)
        return chatSessionId
          ? monitors.filter((monitor) => monitor.chatSessionId === chatSessionId)
          : monitors
      },
      async remove() {},
    },
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))
  screen.acceptSessions([
    { ...first, title: "ASELS setup" },
    { ...second, title: "Risk sizing" },
  ])

  mockInput.pressKey("s", { ctrl: true })
  const modal = await waitForFrame((frame) => (
    frame.includes("Sessions") && frame.includes("2 monitors") && frame.includes("1 loop")
  ))
  const monitored = modal.split("\n").find((line) => line.includes("Risk sizing"))
  expect(monitored).toContain("2 monitors")
  expect(monitored).toContain("1 loop")
  expect(requests).toContain(undefined)

  screen.destroy()
  renderer.destroy()
})

test("shows mobile connections for every session in the sessions modal", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  const first = await chats.create()
  const second = await chats.create()
  chats.mobile = async (sessionId) => ({
    available: true,
    connection: sessionId === second.id
      ? { sessionId, channel: "telegram", displayName: "@ada", connectedAt: 1_000 }
      : null,
  })
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))
  screen.acceptSessions([
    { ...first, title: "Terminal only" },
    { ...second, title: "Connected chat" },
  ])

  mockInput.pressKey("s", { ctrl: true })
  const modal = await waitForFrame((frame) => frame.includes("Sessions") && frame.includes("📱"))
  const lines = modal.split("\n")
  expect(lines.find((line) => line.includes("Connected chat"))).toContain("📱 Connected chat")
  expect(lines.find((line) => line.includes("Terminal only"))).not.toContain("📱")

  screen.destroy()
  renderer.destroy()
})

test("reopens the chat session that was selected last", async () => {
  const chats = fakeChats()
  const first = await chats.create()
  const second = await chats.create()
  await chats.send(first.id, "first conversation")
  await chats.send(second.id, "conversation to restore")

  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialSessionId: second.id,
  })
  renderer.root.add(screen.root)
  screen.mount()

  const restored = await waitForFrame((frame) => frame.includes("conversation to restore"))
  expect(restored).not.toContain("first conversation")

  screen.destroy()
  renderer.destroy()
})

test("replaces a saved selection after that chat no longer exists", async () => {
  const chats = fakeChats()
  const remaining = await chats.create()
  const changes: Array<string | null> = []
  const { renderer, waitFor } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialSessionId: "deleted-chat",
    onSessionChange: (sessionId) => changes.push(sessionId),
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitFor(() => changes.length > 0)
  expect(changes.at(-1)).toBe(remaining.id)

  screen.destroy()
  renderer.destroy()
})

test("takes back the message still waiting, and stops the reply that is running", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, userMessage("waiting", "QUEUED"))
  screen.acceptDelta(session.id, "run-1", { text: "answering" })
  await waitForFrame((frame) => frame.includes("waiting") && frame.includes("answering"))

  mockInput.pressKey("x", { ctrl: true })
  await waitForFrame(() => chats.cancelled.length > 0)
  expect(chats.cancelled).toEqual(["message-waiting"])

  mockInput.pressEscape()
  await waitForFrame(() => chats.aborted.length > 0)
  // Two separate decisions: taking a question back is not the same as stopping the
  // answer already being written.
  expect(chats.aborted).toEqual([session.id])
  await waitForFrame((frame) => !frame.includes("Esc interrupt") && !frame.includes("answering"))

  screen.destroy()
  renderer.destroy()
})

test("settles a selected subagent stream after the server restarts", async () => {
  const { renderer, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  const parent = await chats.create()
  const child: ChatSession = {
    ...parent,
    id: "worker-stale",
    title: "Inspect the market",
    parentSessionId: parent.id,
    agent: "worker",
    running: false,
  }
  chats.sessions.push(child)
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialSessionId: child.id,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("Subagent transcript"))

  screen.acceptRun(child.id, "orphaned-run", "running")
  await waitForFrame((frame) => frame.includes("Esc interrupt") && frame.includes("thinking…"))

  // A reconnect snapshot contains roots only. The selected child is reconciled
  // separately and must not wait for a terminal frame from the dead server.
  screen.acceptSessions([{ ...parent, running: false }])
  await Bun.sleep(1)
  await renderOnce()
  const settled = captureCharFrame()
  expect(settled).toContain("Subagent transcript")
  expect(settled).not.toContain("Esc interrupt")
  expect(settled).not.toContain("thinking…")

  screen.destroy()
  renderer.destroy()
})

test("deleting a chat takes two presses of d, in the sessions modal", async () => {
  const { renderer, mockInput, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
  })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  renderer.keyInput.on("keypress", (key) => screen.handleKey(key))
  await waitForFrame((frame) => frame.includes("ask something"))
  screen.acceptSessions([{ ...chats.sessions[0]!, title: "ASELS setup" }])

  mockInput.pressKey("s", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Sessions") && frame.includes("ASELS setup"))
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
  const ai = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  const trade = labelledPanel(renderer, "TRADE PANEL")
  const logs = labelledPanel(renderer, "LOG PANEL")
  const workspace = new TradingWorkspaceScreen(renderer, { trade, chat: ai, logs })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("a", { ctrl: true })
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

test("a hidden chat releases its input focus and cannot receive another panel's keys", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const chats = fakeChats()
  const chat = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  const trade = labelledPanel(renderer, "TRADE PANEL")
  const logs = labelledPanel(renderer, "LOG PANEL")
  const workspace = new TradingWorkspaceScreen(renderer, { trade, chat, logs })
  renderer.root.add(workspace.root)
  workspace.mount()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("ask something"))
  expect(renderer.currentFocusedRenderable).not.toBeNull()

  // The textarea used to remain the renderer's global focus here, drawing its cursor
  // over the chart and accepting these letters.
  mockInput.pressKey("t", { ctrl: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))
  expect(renderer.currentFocusedRenderable).toBeNull()
  await mockInput.typeText("not chat text")

  mockInput.pressKey("a", { ctrl: true })
  const returned = await waitForFrame((frame) => frame.includes("ask something"))
  expect(returned).not.toContain("not chat text")

  workspace.destroy()
  renderer.destroy()
})

interface LabelledPanel {
  root: BoxRenderable
  handleKey(): void
  destroy(): void
}

function labelledPanel(renderer: RenderContext, label: string): LabelledPanel {
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

test("types one character per keypress once the field has really taken focus", async () => {
  // Tabbing back to the composer focuses the field itself, and from then on the terminal
  // delivers keys to it as well as to this screen. Without the screen claiming each key,
  // every character lands twice — "hheelllloo".
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  // Out to the transcript and back, which is what focuses the field itself.
  mockInput.pressTab()
  mockInput.pressTab()

  await mockInput.typeText("hello")
  mockInput.pressEnter()

  await waitForFrame((frame) => frame.includes("hello"))
  expect(chats.sent).toEqual(["hello"])

  screen.destroy()
  renderer.destroy()
})

test("^O and ^S reach the pickers mid-sentence, without disturbing what is typed", async () => {
  // One spelling for every shortcut, and it works while the field holds the letters —
  // which is the whole reason they are control keys.
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("half a question")
  await waitForFrame((frame) => frame.includes("half a question"))

  mockInput.pressKey("o", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Model for this chat"))
  mockInput.pressEscape()
  await waitForFrame((frame) => !frame.includes("Model for this chat"))

  mockInput.pressKey("s", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Sessions"))
  mockInput.pressEscape()

  // What was half typed is still there: a picker is not a reason to lose a question.
  const back = await waitForFrame((frame) => !frame.includes("Sessions"))
  expect(back).toContain("half a question")

  screen.destroy()
  renderer.destroy()
})

test("a chosen model and reasoning become the default for new chats", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const saved: AiPreferences[] = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account({
      connected: true,
      preferences: { chat: null },
      onSetPreferences: (preferences) => saved.push(preferences),
    }),
    logs: new ApplicationLog(),
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  mockInput.pressKey("o", { ctrl: true })
  await waitForFrame((frame) => frame.includes("Model for this chat"))
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("Test Model — reasoning") && frame.includes("low") && frame.includes("high"))
  mockInput.pressArrow("down")
  mockInput.pressEnter()
  await waitForFrame((frame) => saved.length === 1 && !frame.includes("Model for this chat"))

  expect(saved).toEqual([{
    chat: { providerId: "test-provider", modelId: "test-model", reasoning: "high" },
  }])

  screen.destroy()
  renderer.destroy()
})

test("takes a question of several lines, and sends the whole of it", async () => {
  // A question worth asking a model rarely fits on one line, and one that scrolled
  // sideways could not be read back before being sent.
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  await mockInput.typeText("first thought")
  mockInput.pressEnter({ shift: true })
  await mockInput.typeText("second thought")
  // Both lines are on screen at once, rather than one scrolled out of sight.
  await waitForFrame((frame) => frame.includes("first thought") && frame.includes("second thought"))

  mockInput.pressEnter()
  await waitForFrame(() => chats.sent.length > 0)
  expect(chats.sent).toEqual(["first thought\nsecond thought"])

  screen.destroy()
  renderer.destroy()
})

test("a reply keeps the model that wrote it after the chat is pointed elsewhere", async () => {
  // Changing which model answers must not rewrite history: a label taken from the
  // session would claim the new model wrote every older reply.
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, {
    ...replyMessage("the older answer"),
    model: "gpt-5.6-terra",
    reasoning: "high",
  })
  // The reasoning sits beside the model, because "which model" and "how hard" are one
  // answer to the question of what wrote this.
  await waitForFrame((frame) => frame.includes("gpt-5.6-terra") && frame.includes("high"))

  screen.acceptSessions([{ ...session, model: "claude-fable-5", reasoning: "medium" }])
  const frame = await waitForFrame((content) => content.includes("claude-fable-5"))

  const labelled = frame.split("\n").find((line) => line.includes("gpt-5.6-terra"))
  expect(labelled).toContain("high")
  expect(frame).toContain("the older answer")

  screen.destroy()
  renderer.destroy()
})

test("turns a spinner while a model is thinking, and stops once it has answered", async () => {
  // A model can think for a long time before its first word. A still cursor and a hung
  // run look identical, so something has to move.
  const { renderer, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptDelta(session.id, "run-1", {})
  const waiting = await waitForFrame((frame) => frame.includes("thinking…"))
  const first = spinnerFrame(waiting)
  expect(first).toBeDefined()

  // It turns rather than sitting on one frame. The test renderer only draws when asked,
  // so the wait is for the screen's own timer rather than for a frame.
  await Bun.sleep(200)
  await renderOnce()
  const second = spinnerFrame(captureCharFrame())
  expect(second).toBeDefined()
  expect(second).not.toBe(first)

  screen.acceptMessage(session.id, replyMessage("Thin volumes."))
  await Bun.sleep(50)
  await renderOnce()
  const answered = captureCharFrame()
  expect(answered).toContain("Thin volumes.")
  // Nothing is being waited on any more, so nothing turns.
  expect(spinnerFrame(answered)).toBeUndefined()

  screen.destroy()
  renderer.destroy()
})

/** Which spinner frame is on screen, if any. */
function spinnerFrame(frame: string): string | undefined {
  return [...frame].find((character) => "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".includes(character))
}

test("signs a reply underneath with the model, the time it took and what it cost", async () => {
  // The answer is what a trader came to read; where it came from is what they check
  // afterwards, so it goes below the words rather than above them.
  const { renderer, waitForFrame, captureSpans } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, {
    ...replyMessage("Thin. 12M against a 20M average."),
    elapsedMs: 4_040,
    usage: { inputTokens: 17_200, outputTokens: 1_400, totalTokens: 18_600, costTotal: 0.0412 },
  })
  const frame = await waitForFrame((content) => content.includes("Thin. 12M against a 20M average."))

  const lines = frame.split("\n")
  const said = lines.findIndex((line) => line.includes("Thin. 12M against a 20M average."))
  // The signature is visually attached to the answer, but gets one clear row of air.
  const signature = lines[said + 2] ?? ""
  expect(signature).toContain("test-model")
  expect(signature).toContain("high")
  expect(signature).toContain("4.0s")
  expect(signature).toContain("18.6K")
  expect(signature).toContain("$0.04")
  const modelSpan = captureSpans().lines[said + 2]?.spans.find((span) => span.text.includes("test-model"))
  expect(modelSpan?.fg.toInts()).toEqual([90, 90, 98, 255])

  // And the same conversation's totals stand under the composer, where they say when
  // it is time to start a new chat.
  const status = lines.findLast((line) => line.includes("18.6K")) ?? ""
  expect(status).toContain("(15%)")

  screen.destroy()
  renderer.destroy()
})

test("starts the conversation at the top and keeps it clear of both side edges", async () => {
  const { renderer, waitForFrame, captureSpans } = await createTestRenderer({ width: 60, height: 18, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, userMessage("one-cell prompt", "SENT"))
  await waitForFrame((frame) => frame.includes("one-cell prompt"))

  const renderedLines = captureSpans().lines
  const promptFillLineIndex = renderedLines.findIndex((candidate) =>
    candidate.spans.some((span) => {
      const [red, green, blue] = span.bg.toInts()
      return red === 35 && green === 39 && blue === 47
    }),
  )
  const lineIndex = renderedLines.findIndex((candidate) =>
    candidate.spans.some((span) => span.text.includes("one-cell prompt")),
  )
  const line = renderedLines[lineIndex]
  expect(line).toBeDefined()
  expect(promptFillLineIndex).toBe(0)
  expect(lineIndex).toBe(promptFillLineIndex + 1)

  let column = 0
  const filled: number[] = []
  for (const span of line?.spans ?? []) {
    const [red, green, blue] = span.bg.toInts()
    if (red === 35 && green === 39 && blue === 47) {
      for (let offset = 0; offset < span.width; offset++) filled.push(column + offset)
    }
    column += span.width
  }
  expect(filled[0]).toBe(1)
  expect(filled.at(-1)).toBe(57)

  screen.destroy()
  renderer.destroy()
})

test("gives embedded prompts and the composer a rail instead of a fill", async () => {
  const { renderer, waitForFrame, captureSpans } = await createTestRenderer({ width: 40, height: 16, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  renderer.root.add(screen.root)
  screen.mount()
  const initial = await waitForFrame((frame) => frame.includes("ask something"))
  expect(initial).not.toContain("/help keys")

  screen.acceptMessage(session.id, userMessage("top-edge prompt", "SENT"))
  await waitForFrame((frame) => frame.includes("top-edge prompt"))

  const lines = captureSpans().lines
  const railLineIndex = lines.findIndex((line) => line.spans.some((span) => span.text.includes("┃")))
  const promptLine = lines.find((line) => line.spans.some((span) => span.text.includes("top-edge prompt")))
  const composerLine = lines.find((line) => line.spans.some((span) => span.text.includes("ask something")))
  const promptBackground: [number, number, number, number] = [35, 39, 47, 255]
  expect(railLineIndex).toBe(0)
  expect(promptLine?.spans.some((span) => span.text.includes("›"))).toBe(false)
  expect(promptLine?.spans.map((span) => span.bg.toInts())).not.toContainEqual(promptBackground)
  expect(composerLine?.spans.some((span) => span.text.includes("┃"))).toBe(true)
  expect(composerLine?.spans.some((span) => span.text.includes("›"))).toBe(false)
  expect(composerLine?.spans.map((span) => span.bg.toInts())).not.toContainEqual(promptBackground)
  const promptColumn = promptLine?.spans.map((span) => span.text).join("").indexOf("top-edge prompt")
  const composerColumn = composerLine?.spans.map((span) => span.text).join("").indexOf("ask something")
  expect(composerColumn).toBe(promptColumn)

  screen.destroy()
  renderer.destroy()
})

test("keeps the embedded running hint clear of usage and releases focus when idle", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 40, height: 16, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  session.reasoning = "high"
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, {
    ...replyMessage("Ready."),
    usage: { inputTokens: 17_200, outputTokens: 1_400, totalTokens: 18_600, costTotal: 0.0412 },
  })
  expect(screen.canReleaseFocus()).toBe(true)

  screen.acceptRun(session.id, "run-1", "running")
  const running = await waitForFrame((frame) => frame.includes("Esc interrupt"))
  const runningStatus = running.split("\n").find((line) => line.includes("Esc interrupt")) ?? ""
  expect(runningStatus).toContain("test-model")
  expect(runningStatus).toMatch(/high\s{2,}Esc interrupt/)
  expect(runningStatus).not.toContain("18.6K")
  expect(screen.canReleaseFocus()).toBe(false)

  screen.acceptRun(session.id, "run-1", "done")
  const idle = await waitForFrame((frame) => !frame.includes("Esc interrupt") && frame.includes("18.6K"))
  expect(idle).not.toContain("Esc interrupt")
  expect(screen.canReleaseFocus()).toBe(true)

  screen.destroy()
  renderer.destroy()
})

test("prioritizes active loop counts over usage in a narrow embedded footer", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 40, height: 16, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  session.reasoning = "high"
  await chats.createLoop(session.id, {
    schedule: "INTERVAL",
    intervalMs: 60_000,
    prompt: "Review the position.",
  })
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    embedded: true,
  })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("1 loop"))

  screen.acceptMessage(session.id, {
    ...replyMessage("Ready."),
    usage: { inputTokens: 17_200, outputTokens: 1_400, totalTokens: 18_600, costTotal: 0.0412 },
  })
  const frame = await waitForFrame((value) => value.includes("Ready."))
  const status = frame.split("\n").findLast((line) => line.includes("test-model")) ?? ""
  expect(status).toContain("high")
  expect(status).toContain("1 loop")
  expect(status).not.toContain("18.6K")
  expect(status).not.toContain("$0.04")

  screen.destroy()
  renderer.destroy()
})

test("shows what a model thought, and folds every thought with /thoughts", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  const reply = replyMessage("Higher while it holds 318.")
  screen.acceptMessage(session.id, {
    ...reply,
    thinkingMs: 1_800,
    blocks: [
      { kind: "THINKING", text: "buyers stepped in at 318 twice", toolName: null, toolCallId: null, toolArguments: null },
      ...reply.blocks,
    ],
  })
  // Codex-style reasoning is visible without first discovering a shortcut.
  const expanded = await waitForFrame((frame) => frame.includes("buyers stepped in at 318 twice"))
  expect(expanded).toContain("− thought: 1.8s")

  await mockInput.typeText("/thoughts")
  mockInput.pressEnter()
  const folded = await waitForFrame((frame) => frame.includes("+ thought: 1.8s"))
  expect(folded).not.toContain("buyers stepped in at 318 twice")

  await mockInput.typeText("/thoughts")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("buyers stepped in at 318 twice"))

  screen.destroy()
  renderer.destroy()
})

test("restores and reports the preferred thought visibility", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const changes: boolean[] = []
  const screen = new ChatScreen(renderer, {
    chats,
    account: account(connected),
    logs: new ApplicationLog(),
    initialShowThoughts: false,
    onShowThoughtsChange: (showThoughts) => changes.push(showThoughts),
  })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  await waitForFrame((frame) => frame.includes("ask something"))

  const reply = replyMessage("Higher while it holds 318.")
  screen.acceptMessage(session.id, {
    ...reply,
    thinkingMs: 1_800,
    blocks: [
      { kind: "THINKING", text: "buyers stepped in at 318 twice", toolName: null, toolCallId: null, toolArguments: null },
      ...reply.blocks,
    ],
  })
  const restored = await waitForFrame((frame) => frame.includes("+ thought: 1.8s"))
  expect(restored).not.toContain("buyers stepped in at 318 twice")

  await mockInput.typeText("/thoughts")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("buyers stepped in at 318 twice"))
  await mockInput.typeText("/thoughts")
  mockInput.pressEnter()
  await waitForFrame((frame) => frame.includes("+ thought: 1.8s"))
  expect(changes).toEqual([true, false])

  screen.destroy()
  renderer.destroy()
})

test("does not reserve an empty answer between a tool-call thought and its signature", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptMessage(session.id, {
    ...replyMessage(""),
    elapsedMs: 3_600,
    thinkingMs: 3_600,
    blocks: [
      { kind: "THINKING", text: "Planning monitors tool integration", toolName: null, toolCallId: null, toolArguments: null },
      { kind: "TOOL_CALL", text: null, toolName: "create_market_monitor", toolCallId: "call-1", toolArguments: {} },
    ],
  })
  const frame = await waitForFrame((content) => content.includes("Planning monitors tool integration"))
  const lines = frame.split("\n")
  const thought = lines.findIndex((line) => line.includes("Planning monitors tool integration"))
  const signature = lines.findIndex((line) => line.includes("test-model") && line.includes("3.6s"))
  expect(signature - thought).toBe(1)

  screen.destroy()
  renderer.destroy()
})

test("keeps the complete thought visible while reasoning streams", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptRun(session.id, "run-1", "running")
  screen.acceptDelta(session.id, "run-1", { reasoning: "checking the higher timeframe\n" })
  screen.acceptDelta(session.id, "run-1", { reasoning: "then comparing current volume" })

  const thinking = await waitForFrame((frame) => frame.includes("then comparing current volume"))
  expect(thinking).toContain("checking the higher timeframe")

  screen.destroy()
  renderer.destroy()
})

test("starts turning the moment a run is announced, before any of it has arrived", async () => {
  // The wait before the first word is the longest part of a reasoning reply. A screen
  // that waited for a delta would sit still through exactly the part worth reporting.
  const { renderer, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptRun(session.id, "run-1", "running")
  const waiting = await waitForFrame((frame) => frame.includes("thinking…"))
  expect(spinnerFrame(waiting)).toBeDefined()
  // Esc leads the keys while a reply runs, because that is the one being looked for.
  expect(waiting).toContain("Esc interrupt")

  // The deltas of that same run join what is already on screen rather than restarting it.
  screen.acceptDelta(session.id, "run-1", { text: "Thin." })
  const answering = await waitForFrame((frame) => frame.includes("Thin."))
  expect(answering.split("Thin.").length - 1).toBe(1)

  screen.acceptRun(session.id, "run-1", "done")
  await Bun.sleep(20)
  await renderOnce()
  const done = captureCharFrame()
  expect(done).not.toContain("Esc interrupt")
  expect(done).toContain("/help keys")

  screen.destroy()
  renderer.destroy()
})

test("sounds only when a top-level turn completes", async () => {
  const { renderer } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const visibleSession = await chats.create()
  const backgroundSession = await chats.create()
  const workerSession: ChatSession = {
    ...backgroundSession,
    id: "worker-session",
    parentSessionId: backgroundSession.id,
    agent: "researcher",
  }
  const cues: SoundCue[] = []
  const screen = new ChatScreen(renderer, {
    chats,
    logs: new ApplicationLog(),
    sound: { play: (cue) => cues.push(cue) },
    initialSessionId: visibleSession.id,
  })
  screen.acceptSessions([visibleSession, backgroundSession, workerSession])

  screen.acceptRun(workerSession.id, "worker-run", "running")
  screen.acceptMessage(workerSession.id, replyMessage("Worker research complete."))
  screen.acceptRun(workerSession.id, "worker-run", "done")
  expect(cues).toEqual([])

  screen.acceptRun(backgroundSession.id, "parent-run", "running")
  screen.acceptMessage(backgroundSession.id, replyMessage("Monitor review complete."))
  screen.acceptRun(backgroundSession.id, "parent-run", "done")
  screen.acceptRun(backgroundSession.id, "parent-run", "done")

  expect(cues).toEqual(["COMPLETE"])
  screen.destroy()
  renderer.destroy()
})

test("counts the thinking while it happens, and stops counting at the first word", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  const session = await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  await waitForFrame((frame) => frame.includes("ask something"))

  screen.acceptRun(session.id, "run-1", "running")
  screen.acceptDelta(session.id, "run-1", { reasoning: "weighing the tape" })
  // Still going, so the label is the verb and the number is still moving.
  await waitForFrame((frame) => frame.includes("− thinking:"))

  screen.acceptDelta(session.id, "run-1", { text: "Thin." })
  // The first word ends the thinking, so the label settles and the number stops.
  const answering = await waitForFrame((frame) => frame.includes("− thought:"))
  expect(answering).not.toContain("− thinking:")

  screen.destroy()
  renderer.destroy()
})

test("names the model under the field, and the help modal instead of a row of keys", async () => {
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)

  // What will answer is read while a question is being typed, so it sits under the
  // field rather than in the header.
  const idle = await waitForFrame((frame) => frame.includes("test-model"))
  const lines = idle.split("\n")
  const asked = lines.findIndex((line) => line.includes("ask something"))
  const named = lines.findIndex((line) => line.includes("test-model"))
  expect(named).toBeGreaterThan(asked)
  // The Codex-like status line keeps model and help together beneath the field.
  expect(lines[named]).toContain("/help keys")
  expect(lines[asked]).toContain("›")
  expect(idle).not.toContain("^S sessions")

  await mockInput.typeText("/help")
  mockInput.pressEnter()
  const help = await waitForFrame((frame) => frame.includes("Keys"))
  expect(help).toContain("which model answers this chat")
  expect(help).toContain("take back the last queued message")

  // Anything closes it, since it is a thing to read rather than to operate.
  mockInput.pressEscape()
  await waitForFrame((frame) => !frame.includes("which model answers this chat"))

  screen.destroy()
  renderer.destroy()
})

test("the field opens up for a question that wraps, not only for one with new lines in it", async () => {
  // The field measures its own text. Sizing it by hand looked right for a question typed
  // across explicit lines and failed for the ordinary case — a long paragraph, which
  // wraps — leaving a one-line field scrolling sideways through what was written.
  const { renderer, mockInput, waitForFrame } = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  const chats = fakeChats()
  await chats.create()
  const screen = new ChatScreen(renderer, { chats, account: account(connected), logs: new ApplicationLog() })
  renderer.root.add(screen.root)
  screen.mount()
  routeKeys(renderer, screen)
  const empty = await waitForFrame((frame) => frame.includes("ask something"))
  // One line at rest: an empty field taller than that is a fifth of a short terminal
  // spent on nothing.
  expect(empty.split("\n").filter((line) => line.includes("ask something")).length).toBe(1)

  await mockInput.typeText("where is ASELS heading over the next two sessions, and what invalidates the idea?")
  const grown = await waitForFrame((frame) => frame.includes("invalidates the idea?"))
  // Both ends of the question are on screen, on lines of their own.
  const started = grown.split("\n").findIndex((line) => line.includes("where is ASELS heading"))
  const ended = grown.split("\n").findIndex((line) => line.includes("invalidates the idea?"))
  expect(started).toBeGreaterThanOrEqual(0)
  expect(ended).toBeGreaterThan(started)

  screen.destroy()
  renderer.destroy()
})
