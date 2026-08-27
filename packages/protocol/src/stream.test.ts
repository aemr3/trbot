import { describe, expect, test } from "bun:test"
import { parseClientFrame, parseServerFrame, type ClientFrame, type ServerFrame } from "./stream.ts"

const STOP_RULE = {
  id: "stop-1",
  instrumentUid: "future-1",
  symbol: "F_XU0300826",
  displayName: "XU030 August",
  side: "LONG" as const,
  role: "STOP" as const,
  kind: "PRICE" as const,
  value: 11_000,
  basis: "TOUCH" as const,
  interval: null,
  quantity: null,
  status: "ARMED" as const,
  triggerPrice: 11_000,
  extremePrice: null,
  referencePrice: null,
  atrValue: null,
  createdAt: 1,
  updatedAt: 1,
  triggeredAt: null,
  exitOrderUid: null,
}

const POSITION = {
  uid: "future-1",
  symbol: "F_XU0300826",
  displayName: "XU030 August",
  quantity: 1,
  averageCost: 11_100,
  currentPrice: 11_120,
  unrealizedProfitLoss: 20,
  currency: "TRY",
}

const PRICE_ALERT = {
  id: "alert-1",
  instrumentUid: "future-1",
  symbol: "F_XU0300826",
  displayName: "XU030 August",
  direction: "ABOVE" as const,
  kind: "PRICE" as const,
  value: 11_200,
  basis: "TOUCH" as const,
  interval: null,
  repeat: "ONCE" as const,
  status: "ARMED" as const,
  triggerPrice: 11_200,
  extremePrice: null,
  referencePrice: null,
  atrValue: null,
  createdAt: 1,
  updatedAt: 1,
  triggeredAt: null,
  triggeredPrice: null,
  triggerId: null,
}

const CHAT_SESSION = {
  id: "chat-1",
  title: "Market structure",
  parentSessionId: null,
  parentPromptMessageId: null,
  parentToolCallId: null,
  agent: null,
  model: "gpt-5",
  provider: "openai",
  reasoning: "high",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  queued: 0,
  running: false,
}

const CHAT_MESSAGE = {
  id: "message-1",
  role: "ASSISTANT" as const,
  status: "COMPLETE" as const,
  text: "Ready.",
  blocks: [{ kind: "TEXT" as const, text: "Ready.", toolName: null, toolCallId: null, toolArguments: null }],
  toolName: null,
  toolCallId: null,
  isError: false,
  errorMessage: null,
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costTotal: 0 },
  model: "gpt-5",
  reasoning: "high",
  elapsedMs: 100,
  thinkingMs: 50,
  createdAt: 2,
}

/**
 * Anything that gets past this is dispatched and has its fields read without a
 * further guard, so a frame missing one becomes a thrown socket handler rather
 * than a message the server ignores. A newer client's frame arrives here too.
 */
describe("client frames the server will act on", () => {
  test("accepts the frames a client actually sends", () => {
    const frames: ClientFrame[] = [
      { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] },
      { type: "subscribe", channel: "equityQuotes", symbol: "THYAO" },
      { type: "subscribe", channel: "depth", symbol: "THYAO" },
      { type: "subscribe", channel: "account" },
      { type: "unsubscribe", channel: "quotes" },
      { type: "pendingOrders", orderUids: [] },
      { type: "alertDecision", alertId: "alert-1", decision: "dismiss" },
    ]

    for (const frame of frames) expect(parseClientFrame(JSON.stringify(frame))).toEqual(frame)
  })

  test("refuses a frame whose payload is missing or the wrong shape", () => {
    const frames = [
      // The one a version-skewed client sends: right type, no symbols.
      { type: "subscribe", channel: "quotes" },
      { type: "subscribe", channel: "quotes", symbols: "F_XU0300826" },
      { type: "subscribe", channel: "quotes", symbols: [1, 2] },
      { type: "subscribe", channel: "equityQuotes" },
      { type: "subscribe", channel: "depth", symbol: 7 },
      { type: "subscribe", channel: "positions" },
      { type: "unsubscribe" },
      { type: "unsubscribe", channel: "positions" },
      { type: "pendingOrders" },
      { type: "stopDecision", ruleId: "rule-1", decision: "confirm" },
      { type: "alertDecision", decision: "dismiss" },
      { type: "trade", instrumentUid: "future-1" },
      {},
    ]

    for (const frame of frames) expect(parseClientFrame(JSON.stringify(frame))).toBeNull()
  })

  test("refuses anything that is not an object", () => {
    for (const data of ["null", "7", '"subscribe"', "[]", "not json"]) {
      expect(parseClientFrame(data)).toBeNull()
    }
  })
})

/**
 * The same in the other direction. A listener reads the payload without a
 * further guard, so a frame carrying only its type hands `undefined` to the
 * screen rather than being ignored.
 */
describe("server frames the terminal will act on", () => {
  test("accepts the frames the server actually sends", () => {
    const frames: ServerFrame[] = [
      {
        type: "quotes",
        update: { symbol: "F_XU0300826", lastPrice: 11_120, sessionStatus: "OPEN", timestamp: 1 },
      },
      {
        type: "equityQuotes",
        update: { symbol: "THYAO", lastPrice: 350, sessionStatus: "OPEN", timestamp: 1 },
      },
      {
        type: "depth",
        book: {
          symbol: "THYAO",
          bids: [{ price: 349.9, lots: 10, orderCount: 2 }],
          asks: [{ price: 350, lots: 8, orderCount: 1 }],
          buyLots: 10,
          sellLots: 8,
          trades: [],
          marketClosed: false,
        },
      },
      { type: "depthStatus", status: "live" },
      {
        type: "account",
        update: { type: "position", uid: "future-1", quantity: 1, averageCost: 11_100, country: "TR" },
      },
      { type: "status", channel: "quotes", connected: true },
      { type: "session", state: "expired" },
      {
        type: "stopTriggered",
        event: { rule: STOP_RULE, position: POSITION, price: 11_000, quantity: 1, side: "SELL", priceAgeMs: 10 },
        remainingMs: 30_000,
        held: false,
      },
      { type: "stopResolved", ruleId: "rule-1", outcome: "SUBMITTED" },
      {
        type: "stops",
        views: [{ rule: STOP_RULE, level: 11_000, lastPrice: 11_120, distancePercent: -1, feed: "live", hasPosition: true }],
      },
      { type: "alertTriggered", event: { alert: PRICE_ALERT, price: 11_200, priceAgeMs: 10 } },
      {
        type: "alerts",
        views: [{ alert: PRICE_ALERT, level: 11_200, lastPrice: 11_120, distancePercent: 0.7, feed: "live" }],
      },
      { type: "chatSessions", sessions: [CHAT_SESSION] },
      { type: "chatMessage", sessionId: "chat-1", message: CHAT_MESSAGE },
      { type: "chatMessageRemoved", sessionId: "chat-1", messageId: "message-1" },
      { type: "chatDelta", sessionId: "chat-1", runId: "run-1", seq: 1, text: "Ready" },
      {
        type: "chatDelta",
        sessionId: "chat-1",
        runId: "run-1",
        seq: 2,
        retry: { attempt: 1, maxAttempts: 5, message: "Provider is overloaded", reportedAt: 1_000, nextAt: 3_000 },
      },
      { type: "chatDelta", sessionId: "chat-1", runId: "run-1", seq: 3, retry: null },
      {
        type: "chatRun",
        sessionId: "chat-1",
        runId: "run-1",
        status: "done",
        promptMessageId: "message-prompt",
        message: CHAT_MESSAGE,
      },
      {
        type: "chatQuestionAsked",
        request: {
          id: "question-1",
          sessionId: "chat-1",
          questions: [{
            header: "Strategy",
            question: "Which setup?",
            options: [{ label: "Breakout", description: "Wait for resistance" }],
          }],
        },
      },
      { type: "chatQuestionResolved", requestId: "question-1", sessionId: "chat-1" },
      {
        type: "chatPermissionRequested",
        request: {
          id: "permission-1",
          sessionId: "chat-1",
          toolName: "place_viop_order",
          action: "BUY 1 F_ASELS0826 at 100",
          reason: null,
          scope: "SESSION",
          createdAt: 1_000,
        },
      },
      { type: "chatPermissionResolved", requestId: "permission-1", sessionId: "chat-1" },
      { type: "chatPermissionModeChanged", state: { sessionId: "chat-1", mode: "AUTO" } },
      {
        type: "chatNotification",
        notification: {
          id: "notification-1",
          sessionId: "chat-1",
          title: "Review complete",
          message: "The setup remains valid.",
          urgency: "INFO",
          createdAt: 1_000,
        },
      },
      { type: "chatNotificationDismissed", notificationId: "notification-1" },
      { type: "error", message: "something went wrong" },
      { type: "error", channel: "depth", message: "no book for this symbol" },
    ]

    for (const frame of frames) expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame)
  })

  test("refuses a known frame with nothing in it", () => {
    const frames = [
      // The one a version-skewed server sends: right type, no payload.
      { type: "quotes" },
      { type: "equityQuotes", update: null },
      { type: "depth" },
      { type: "depthStatus" },
      { type: "account", update: "position" },
      { type: "status", channel: "quotes" },
      { type: "status", channel: "positions", connected: true },
      { type: "session", state: "renewed" },
      { type: "stopTriggered", event: {}, held: false },
      { type: "stopResolved", ruleId: "rule-1", outcome: "PARTIAL" },
      { type: "stops" },
      { type: "alerts", views: {} },
      { type: "alertTriggered" },
      { type: "chatQuestionAsked", request: { id: "question-1", sessionId: "chat-1", questions: [{}] } },
      { type: "chatQuestionResolved", requestId: "question-1" },
      { type: "chatPermissionRequested", request: {} },
      { type: "chatPermissionResolved", requestId: "permission-1" },
      { type: "chatPermissionModeChanged", state: { sessionId: "chat-1", mode: "ALWAYS" } },
      { type: "chatNotification", notification: {} },
      { type: "chatNotificationDismissed" },
      { type: "chatDelta", sessionId: "chat-1", runId: "run-1", seq: 1, retry: { attempt: 0 } },
      { type: "error" },
      { type: "chatter", message: "hello" },
      {},
    ]

    for (const frame of frames) expect(parseServerFrame(JSON.stringify(frame))).toBeNull()
  })

  /**
   * The payload being an object is not enough. A panel reads `book.symbol` and
   * `view.rule.displayName` off what it is handed, so an empty one is a crash a
   * level below here rather than a frame anything can ignore.
   */
  test("refuses a payload that is an object but empty", () => {
    const frames = [
      { type: "depth", book: {} },
      { type: "depth", book: { symbol: "AKBNK", timestamp: 1, bids: [] } },
      { type: "quotes", update: {} },
      { type: "quotes", update: { symbol: 7 } },
      { type: "quotes", update: { symbol: "F_AKBNK0826", lastPrice: 114, sessionStatus: null } },
      { type: "equityQuotes", update: { lastPrice: 12 } },
      { type: "account", update: {} },
      { type: "stopTriggered", event: { rule: {} }, remainingMs: 1, held: false },
      { type: "stopTriggered", event: {}, remainingMs: 1, held: false },
      { type: "alertTriggered", event: {} },
      { type: "stops", views: [{}] },
      { type: "stops", views: [{ rule: {} }, {}] },
      { type: "alerts", views: [{ alert: null }] },
    ]

    for (const frame of frames) expect(parseServerFrame(JSON.stringify(frame))).toBeNull()
  })
})
