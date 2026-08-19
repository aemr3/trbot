import { describe, expect, test } from "bun:test"
import { parseClientFrame, parseServerFrame, type ClientFrame, type ServerFrame } from "./stream.ts"

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
      { type: "quotes", update: { symbol: "F_XU0300826" } as never },
      { type: "equityQuotes", update: { symbol: "THYAO" } as never },
      { type: "depth", book: { symbol: "THYAO" } as never },
      { type: "depthStatus", status: "live" },
      { type: "account", update: { type: "position" } as never },
      { type: "status", channel: "quotes", connected: true },
      { type: "session", state: "expired" },
      { type: "stopTriggered", event: { rule: {}, position: {} } as never, remainingMs: 30_000, held: false },
      { type: "stopResolved", ruleId: "rule-1", outcome: "SUBMITTED" },
      { type: "stops", views: [{ rule: {} }] as never },
      { type: "alertTriggered", event: { alert: {} } as never },
      { type: "alerts", views: [{ alert: {} }] as never },
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
      { type: "quotes", update: {} },
      { type: "quotes", update: { symbol: 7 } },
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
