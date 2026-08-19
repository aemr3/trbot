const API_PREFIX = "/v1"

/** Header deduplicating a mutation so a retry cannot place a second order. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key"

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
  watchlistPreferences: `${API_PREFIX}/preferences/watchlist`,
  alerts: `${API_PREFIX}/alerts`,
  alert: (id: string) => `${API_PREFIX}/alerts/${encodeURIComponent(id)}`,
  alertStatus: (id: string) => `${API_PREFIX}/alerts/${encodeURIComponent(id)}/status`,
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
  /** Which model answers the overview, and which a new chat session starts on. */
  aiPreferences: `${API_PREFIX}/ai/preferences`,
  overview: `${API_PREFIX}/ai/overview`,
  chatSessions: `${API_PREFIX}/ai/chat/sessions`,
  chatSession: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}`,
  chatMessages: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/messages`,
  chatMessage: (sessionId: string, messageId: string) =>
    `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
  chatAbort: (id: string) => `${API_PREFIX}/ai/chat/sessions/${encodeURIComponent(id)}/abort`,
  overviewSnapshots: `${API_PREFIX}/overview-snapshots`,
  streamTicket: `${API_PREFIX}/stream/ticket`,
  stream: `${API_PREFIX}/stream`,
  health: `${API_PREFIX}/health`,
} as const

export interface SessionState {
  authenticated: boolean
}

export interface StreamTicket {
  ticket: string
  expiresAt: number
}
