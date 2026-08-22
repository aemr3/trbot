import { z } from "zod"

const API_PREFIX = "/v1"

/** Header deduplicating a mutation so a retry cannot place a second order. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key"
/** Identifies one live client process so its temporary grants end with its socket. */
export const CLIENT_INSTANCE_HEADER = "Trbot-Client-Instance"
export const ClientInstanceIdSchema = z.string().uuid()

/**
 * Every route the server serves. Paths are written as functions where they take
 * a parameter, so a client never assembles a path by hand.
 */
export const ROUTES = {
  instruments: `${API_PREFIX}/instruments`,
  contractDetails: (uid: string) => `${API_PREFIX}/instruments/${encodeURIComponent(uid)}/contract`,
  candles: (uid: string) => `${API_PREFIX}/instruments/${encodeURIComponent(uid)}/candles`,
  news: `${API_PREFIX}/news`,
  article: (uid: string) => `${API_PREFIX}/news/${encodeURIComponent(uid)}`,
  account: `${API_PREFIX}/account`,
  memberFeatures: `${API_PREFIX}/member/features`,
  brokerageDistribution: `${API_PREFIX}/brokerage/distribution`,
  settlement: `${API_PREFIX}/settlement`,
  pendingOrders: `${API_PREFIX}/orders/pending`,
  prepareOrder: `${API_PREFIX}/orders/prepare`,
  placeOrder: `${API_PREFIX}/orders`,
  cancelOrders: `${API_PREFIX}/orders/cancel`,
  exitPositions: `${API_PREFIX}/positions/exit`,
  exitPosition: (uid: string) => `${API_PREFIX}/positions/${encodeURIComponent(uid)}/exit`,
  appPreferences: `${API_PREFIX}/preferences/app`,
  alerts: `${API_PREFIX}/alerts`,
  alert: (id: string) => `${API_PREFIX}/alerts/${encodeURIComponent(id)}`,
  alertStatus: (id: string) => `${API_PREFIX}/alerts/${encodeURIComponent(id)}/status`,
  marketMonitors: `${API_PREFIX}/ai/market-monitors`,
  marketMonitor: (id: string) => `${API_PREFIX}/ai/market-monitors/${encodeURIComponent(id)}`,
  stops: `${API_PREFIX}/stops`,
  stop: (id: string) => `${API_PREFIX}/stops/${encodeURIComponent(id)}`,
  stopStatus: (id: string) => `${API_PREFIX}/stops/${encodeURIComponent(id)}/status`,
  /** Answering a fired stop. Acknowledged, unlike the socket frame it replaced. */
  stopDecision: (id: string) => `${API_PREFIX}/stops/${encodeURIComponent(id)}/decision`,
  login: `${API_PREFIX}/auth/login`,
  otp: `${API_PREFIX}/auth/otp`,
  session: `${API_PREFIX}/auth/session`,
  /** Every model provider the harness offers, connected or not. */
  aiProviders: `${API_PREFIX}/ai/providers`,
  /**
   * One provider's connection. `POST` takes the credential a terminal's login
   * produced — the only message that carries a secret, and only inward — and
   * `DELETE` forgets it. Nothing hands a credential back out.
   */
  aiProvider: (providerId: string) => `${API_PREFIX}/ai/providers/${encodeURIComponent(providerId)}`,
  /** The models usable right now, across every connected provider. */
  aiModels: `${API_PREFIX}/ai/models`,
  /** Which model a new chat session starts on. */
  aiPreferences: `${API_PREFIX}/ai/preferences`,
  chatSessions: `${API_PREFIX}/ai/chat/sessions`,
  chatSession: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}`,
  chatSessionChildren: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/children`,
  chatMessages: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/messages`,
  chatMessage: (sessionId: string, messageId: string) =>
    `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
  chatUndo: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/undo`,
  chatUndoPreview: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/undo/preview`,
  chatAbort: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/abort`,
  chatCompact: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/compact`,
  chatAutomations: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/automations`,
  chatGoal: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/goal`,
  chatLoops: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/loops`,
  chatLoop: (sessionId: string, loopId: string) =>
    `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(sessionId)}/loops/${encodeURIComponent(loopId)}`,
  chatQuestions: `${API_PREFIX}/ai/chat/questions`,
  chatQuestionReply: (id: string) => `${API_PREFIX}/ai/chat/questions/${encodeURIComponent(id)}/reply`,
  chatQuestion: (id: string) => `${API_PREFIX}/ai/chat/questions/${encodeURIComponent(id)}`,
  chatPermissions: `${API_PREFIX}/ai/chat/permissions`,
  chatPermissionReply: (id: string) => `${API_PREFIX}/ai/chat/permissions/${encodeURIComponent(id)}/reply`,
  chatNotifications: `${API_PREFIX}/ai/chat/notifications`,
  chatNotification: (id: string) => `${API_PREFIX}/ai/chat/notifications/${encodeURIComponent(id)}`,
  streamTicket: `${API_PREFIX}/stream/ticket`,
  stream: `${API_PREFIX}/stream`,
  health: `${API_PREFIX}/health`,
} as const

export interface SessionState {
  authenticated: boolean
}

export const SessionStateSchema: z.ZodType<SessionState> = z.object({ authenticated: z.boolean() })

export const OkResponseSchema = z.object({ ok: z.literal(true) })

export interface StreamTicket {
  ticket: string
  expiresAt: number
}

export const StreamTicketSchema: z.ZodType<StreamTicket> = z.object({
  ticket: z.string(),
  expiresAt: z.number(),
})

const RequiredTextSchema = z.string().refine((value) => value.trim().length > 0)

export const LoginRequestSchema = z.object({
  username: RequiredTextSchema,
  password: RequiredTextSchema,
})

export const OtpRequestSchema = z.object({ code: RequiredTextSchema })
