import {
  ChatMessageSchema,
  ChatSessionSchema,
  type ChatMessage,
  type ChatRunStatus,
  type ChatSession,
} from "@trbot/chat/session.ts"
import { ChatQuestionRequestSchema, type ChatQuestionRequest } from "@trbot/chat/question.ts"
import { ChatNotificationSchema, type ChatNotification } from "@trbot/chat/notification.ts"
import {
  ChatPermissionModeStateSchema,
  ChatPermissionRequestSchema,
  type ChatPermissionModeState,
  type ChatPermissionRequest,
} from "@trbot/chat/permission.ts"
import {
  AlertTriggerEventSchema,
  PriceAlertViewSchema,
  type AlertTriggerEvent,
  type PriceAlertView,
} from "@trbot/market/alert-monitor.ts"
import { DEPTH_STATUSES, DepthBookSchema, type DepthBook, type DepthStatus } from "@trbot/market/depth.ts"
import { EquityQuoteUpdateSchema, type EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import { QuoteUpdateSchema, type QuoteUpdate } from "@trbot/market/quote-stream.ts"
import { AccountLiveUpdateSchema, type AccountLiveUpdate } from "@trbot/trading/account.ts"
import {
  STOP_OUTCOMES,
  StopRuleViewSchema,
  StopTriggerEventSchema,
  type StopOutcome,
  type StopRuleView,
  type StopTriggerEvent,
} from "@trbot/trading/stop-monitor.ts"
import { z } from "zod"

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

const SubscribeFrameSchema = z.union([
  z.object({ type: z.literal("subscribe"), channel: z.literal("quotes"), symbols: z.array(z.string()) }),
  z.object({ type: z.literal("subscribe"), channel: z.literal("equityQuotes"), symbol: z.string() }),
  z.object({ type: z.literal("subscribe"), channel: z.literal("depth"), symbol: z.string() }),
  z.object({ type: z.literal("subscribe"), channel: z.literal("account") }),
])

export const ClientFrameSchema: z.ZodType<ClientFrame> = z.union([
  SubscribeFrameSchema,
  z.object({ type: z.literal("unsubscribe"), channel: z.enum(STREAM_CHANNELS) }),
  z.object({ type: z.literal("pendingOrders"), orderUids: z.array(z.string()) }),
  z.object({
    type: z.literal("alertDecision"),
    alertId: z.string(),
    decision: z.enum(["dismiss", "rearm"]),
  }),
])

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
  | {
      type: "chatRun"
      sessionId: string
      runId: string
      status: ChatRunStatus
      /** The input that owns this run; absent only on frames from older servers. */
      promptMessageId?: string
      message?: ChatMessage
      error?: string
    }
  | { type: "chatQuestionAsked"; request: ChatQuestionRequest }
  | { type: "chatQuestionResolved"; requestId: string; sessionId: string }
  | { type: "chatPermissionRequested"; request: ChatPermissionRequest }
  | { type: "chatPermissionResolved"; requestId: string; sessionId: string }
  | { type: "chatPermissionModeChanged"; state: ChatPermissionModeState }
  | { type: "chatNotification"; notification: ChatNotification }
  | { type: "chatNotificationDismissed"; notificationId: string }

// Owned by the trading package: how a stop ended is a trading fact, and this
// package already depends on it.
export { type StopOutcome } from "@trbot/trading/stop-monitor.ts"

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

export const ServerFrameSchema: z.ZodType<ServerFrame> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quotes"), update: QuoteUpdateSchema }),
  z.object({ type: z.literal("equityQuotes"), update: EquityQuoteUpdateSchema }),
  z.object({ type: z.literal("depth"), book: DepthBookSchema }),
  z.object({ type: z.literal("depthStatus"), status: z.enum(DEPTH_STATUSES) }),
  z.object({ type: z.literal("account"), update: AccountLiveUpdateSchema }),
  z.object({ type: z.literal("status"), channel: z.enum(STREAM_CHANNELS), connected: z.boolean() }),
  z.object({ type: z.literal("session"), state: z.literal("expired") }),
  z.object({
    type: z.literal("stopTriggered"),
    event: StopTriggerEventSchema,
    remainingMs: z.number(),
    held: z.boolean(),
  }),
  z.object({ type: z.literal("stopResolved"), ruleId: z.string(), outcome: z.enum(STOP_OUTCOMES) }),
  z.object({ type: z.literal("stops"), views: z.array(StopRuleViewSchema) }),
  z.object({ type: z.literal("alertTriggered"), event: AlertTriggerEventSchema }),
  z.object({ type: z.literal("alerts"), views: z.array(PriceAlertViewSchema) }),
  z.object({ type: z.literal("chatSessions"), sessions: z.array(ChatSessionSchema) }),
  z.object({ type: z.literal("chatMessage"), sessionId: z.string(), message: ChatMessageSchema }),
  z.object({ type: z.literal("chatMessageRemoved"), sessionId: z.string(), messageId: z.string() }),
  z.object({
    type: z.literal("chatDelta"),
    sessionId: z.string(),
    runId: z.string(),
    seq: z.number(),
    text: z.string().optional(),
    reasoning: z.string().optional(),
    toolName: z.string().optional(),
  }),
  z.object({
    type: z.literal("chatRun"),
    sessionId: z.string(),
    runId: z.string(),
    status: z.enum(["running", "done", "failed", "aborted"]),
    promptMessageId: z.string().optional(),
    message: ChatMessageSchema.optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("chatQuestionAsked"), request: ChatQuestionRequestSchema }),
  z.object({ type: z.literal("chatQuestionResolved"), requestId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("chatPermissionRequested"), request: ChatPermissionRequestSchema }),
  z.object({ type: z.literal("chatPermissionResolved"), requestId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("chatPermissionModeChanged"), state: ChatPermissionModeStateSchema }),
  z.object({ type: z.literal("chatNotification"), notification: ChatNotificationSchema }),
  z.object({ type: z.literal("chatNotificationDismissed"), notificationId: z.string() }),
  z.object({ type: z.literal("error"), channel: z.enum(STREAM_CHANNELS).optional(), message: z.string() }),
])

/**
 * Whether a decoded frame is one the server can act on.
 *
 * Every field is checked, not just the discriminator: the fields are read
 * without a further guard once a frame is dispatched, so a truncated or
 * version-skewed frame that passes here becomes a thrown handler rather than an
 * ignored message.
 */
export function parseClientFrame(data: string): ClientFrame | null {
  try {
    const parsed = ClientFrameSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parseServerFrame(data: string): ServerFrame | null {
  try {
    const parsed = ServerFrameSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
