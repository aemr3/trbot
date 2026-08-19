import type { ChatMessage, ChatRunStatus, ChatSession } from "@trbot/chat/session.ts"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { AlertTriggerEvent, PriceAlertView } from "@trbot/market/alert-monitor.ts"
import { DEPTH_STATUSES } from "@trbot/market/depth.ts"
import type { DepthBook, DepthStatus } from "@trbot/market/depth.ts"
import type { EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { AccountLiveUpdate } from "@trbot/trading/account.ts"
import { STOP_OUTCOMES } from "@trbot/trading/stop-monitor.ts"
import type { StopOutcome, StopRuleView, StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"

export const STREAM_CHANNELS = ["quotes", "equityQuotes", "depth", "account"] as const
export type StreamChannel = (typeof STREAM_CHANNELS)[number]

export type ClientFrame =
  | { type: "subscribe"; channel: "quotes"; symbols: string[] }
  | { type: "subscribe"; channel: "equityQuotes"; symbol: string }
  | { type: "subscribe"; channel: "depth"; symbol: string }
  | { type: "subscribe"; channel: "account" }
  | { type: "unsubscribe"; channel: StreamChannel }
  // Mirrors AccountStream.setPendingOrders.
  | { type: "pendingOrders"; orderUids: string[] }
  // Answering a fired alert. A stop decision does not travel this way: it needs
  // an acknowledgement, so it goes over HTTP. See ROUTES.stopDecision.
  | { type: "alertDecision"; alertId: string; decision: "dismiss" | "rearm" }

export type ServerFrame =
  | { type: "quotes"; update: QuoteUpdate }
  | { type: "equityQuotes"; update: EquityQuoteUpdate }
  | { type: "depth"; book: DepthBook }
  | { type: "depthStatus"; status: DepthStatus }
  | { type: "account"; update: AccountLiveUpdate }
  | { type: "status"; channel: StreamChannel; connected: boolean }
  | { type: "session"; state: "expired" }
  | StopTriggerFrame
  | { type: "stopResolved"; ruleId: string; outcome: StopOutcome }
  | { type: "stops"; views: StopRuleView[] }
  | { type: "alertTriggered"; event: AlertTriggerEvent }
  | { type: "alerts"; views: PriceAlertView[] }
  | ChatFrame
  | { type: "error"; channel?: StreamChannel; message: string }

/**
 * What a chat is doing, from the process that is doing it.
 *
 * A run belongs to the server, not to whoever asked for it, so a reply keeps
 * being generated and stored when the terminal that started it closes its tab or
 * quits — and every attached client sees the same one. These frames are what make
 * that visible, so they are broadcast rather than sent to a subscriber: a client
 * did not ask for a chat channel, it asked for a chat.
 *
 * `seq` counts deltas within a run, so a client that has fallen behind can tell it
 * missed one and re-read the session instead of rendering a transcript with a hole
 * in it.
 */
export type ChatFrame =
  | { type: "chatSessions"; sessions: ChatSession[] }
  | { type: "chatMessage"; sessionId: string; message: ChatMessage }
  | { type: "chatMessageRemoved"; sessionId: string; messageId: string }
  | { type: "chatDelta"; sessionId: string; runId: string; seq: number; text?: string; reasoning?: string; toolName?: string }
  | { type: "chatRun"; sessionId: string; runId: string; status: ChatRunStatus; message?: ChatMessage; error?: string }
  | { type: "chatQuestionAsked"; request: ChatQuestionRequest }
  | { type: "chatQuestionResolved"; requestId: string; sessionId: string }

// Owned by the trading package: how a stop ended is a trading fact, and this
// package already depends on it.
export {  type StopOutcome } from "@trbot/trading/stop-monitor.ts"

/**
 * A stop rule has reached its level and the server has started the countdown.
 * The exit is sent when the countdown expires unless a client cancels or holds
 * it first — the behaviour is a dead man's switch, so an unattended server still
 * protects the position.
 */
interface StopTriggerFrame {
  type: "stopTriggered"
  event: StopTriggerEvent
  /** Milliseconds remaining when the frame was sent. */
  remainingMs: number
  /** True when a client has paused the countdown. */
  held: boolean
}

/**
 * Whether a decoded frame is one the server can act on.
 *
 * Every field is checked, not just the discriminator: the fields are read
 * without a further guard once a frame is dispatched, so a truncated or
 * version-skewed frame that passes here becomes a thrown handler rather than an
 * ignored message.
 */
function isClientFrame(value: unknown): value is ClientFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>

  switch (frame.type) {
    case "subscribe":
      if (frame.channel === "quotes") return isStringList(frame.symbols)
      if (frame.channel === "equityQuotes" || frame.channel === "depth") return typeof frame.symbol === "string"
      return frame.channel === "account"
    case "unsubscribe":
      return isChannel(frame.channel)
    case "pendingOrders":
      return isStringList(frame.orderUids)
    case "alertDecision":
      return typeof frame.alertId === "string" && isOneOf(frame.decision, ALERT_DECISIONS)
    default:
      return false
  }
}

const ALERT_DECISIONS = ["dismiss", "rearm"] as const
const CHAT_RUN_STATUSES = ["running", "done", "failed", "aborted"] as const

function isChannel(value: unknown): value is StreamChannel {
  return isOneOf(value, STREAM_CHANNELS)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

export function parseClientFrame(data: string): ClientFrame | null {
  try {
    const decoded: unknown = JSON.parse(data)
    return isClientFrame(decoded) ? decoded : null
  } catch {
    return null
  }
}

/**
 * Whether a decoded frame is one a client can act on.
 *
 * The same reasoning as `isClientFrame`, in the other direction: a listener
 * reads the payload without a further guard, so a frame carrying only its type
 * would hand `undefined` to the screen rather than being ignored. A frame this
 * client has never heard of is ignored, which is what lets the server add one.
 */
function isServerFrame(value: unknown): value is ServerFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>

  switch (frame.type) {
    case "quotes":
    case "equityQuotes":
      return hasSymbol(frame.update)
    case "account":
      return typeof field(frame.update, "type") === "string"
    case "depth":
      return hasSymbol(frame.book)
    case "depthStatus":
      return isOneOf(frame.status, DEPTH_STATUSES)
    case "status":
      return isChannel(frame.channel) && typeof frame.connected === "boolean"
    case "session":
      return frame.state === "expired"
    case "stopTriggered":
      return isTrigger(frame.event) && typeof frame.remainingMs === "number" && typeof frame.held === "boolean"
    case "stopResolved":
      return typeof frame.ruleId === "string" && isOneOf(frame.outcome, STOP_OUTCOMES)
    case "stops":
      return isListOf(frame.views, (view) => isObject(field(view, "rule")))
    case "alerts":
      return isListOf(frame.views, (view) => isObject(field(view, "alert")))
    case "alertTriggered":
      return isObject(field(frame.event, "alert"))
    case "chatSessions":
      return isListOf(frame.sessions, (session) => typeof field(session, "id") === "string")
    case "chatMessage":
      return typeof frame.sessionId === "string" && typeof field(frame.message, "id") === "string"
    case "chatMessageRemoved":
      return typeof frame.sessionId === "string" && typeof frame.messageId === "string"
    case "chatDelta":
      return typeof frame.sessionId === "string" && typeof frame.runId === "string"
        && typeof frame.seq === "number"
    case "chatRun":
      return typeof frame.sessionId === "string" && typeof frame.runId === "string"
        && isOneOf(frame.status, CHAT_RUN_STATUSES)
    case "chatQuestionAsked":
      return isChatQuestionRequest(frame.request)
    case "chatQuestionResolved":
      return typeof frame.requestId === "string" && typeof frame.sessionId === "string"
    case "error":
      return typeof frame.message === "string" && (frame.channel === undefined || isChannel(frame.channel))
    default:
      return false
  }
}

/**
 * The payload checks go one level in, not just "is an object".
 *
 * A screen reads `book.symbol` and `view.rule.displayName` straight off what it
 * is handed, so `{"type":"depth","book":{}}` is not a frame it can ignore — it
 * is a crash a level down from here, in a panel that has no way to check.
 */
function hasSymbol(value: unknown): boolean {
  return typeof field(value, "symbol") === "string"
}

function isTrigger(value: unknown): boolean {
  return isObject(field(value, "rule")) && isObject(field(value, "position"))
}

function isChatQuestionRequest(value: unknown): boolean {
  return typeof field(value, "id") === "string"
    && typeof field(value, "sessionId") === "string"
    && isListOf(field(value, "questions"), (question) => (
      typeof field(question, "question") === "string"
      && typeof field(question, "header") === "string"
      && (field(question, "multiple") === undefined || typeof field(question, "multiple") === "boolean")
      && isListOf(field(question, "options"), (option) => (
        typeof field(option, "label") === "string"
        && typeof field(option, "description") === "string"
      ))
    ))
}

function field(value: unknown, name: string): unknown {
  return isObject(value) ? (value as Record<string, unknown>)[name] : undefined
}

function isListOf(value: unknown, ok: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(ok)
}

export function parseServerFrame(data: string): ServerFrame | null {
  try {
    const decoded: unknown = JSON.parse(data)
    return isServerFrame(decoded) ? decoded : null
  } catch {
    return null
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null
}
