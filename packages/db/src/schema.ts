import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CHAT_PERMISSION_MODES } from "@trbot/chat/permission.ts"
import { TRADE_RIGHT_VIEWS } from "@trbot/preferences/app.ts"

export const authState = sqliteTable("auth_state", {
  accountKey: text("account_key").primaryKey(),
  memberUid: text("member_uid"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  deviceId: text("device_id").notNull(),
  userAgentUid: text("user_agent_uid").notNull(),
  privateKeyPem: text("private_key_pem").notNull(),
  publicKeyBase64: text("public_key_base64").notNull(),
  loginReferenceCode: text("login_reference_code"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

/**
 * One row per connected model provider.
 *
 * The credential is the harness's own record, kept as JSON rather than spread over
 * columns: it is a union — an API key for most providers, an OAuth grant for the
 * subscription ones — with an open field set, so a column per field would mean a
 * migration per credential kind. Nothing but the harness reads inside it.
 */
export const aiCredentials = sqliteTable("ai_credentials", {
  providerId: text("provider_id").primaryKey(),
  credential: text("credential").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

/**
 * Which model a new chat session starts on.
 *
 * A single row. Every column is nullable and nothing stands behind them: null means
 * nobody has chosen yet, which the composer says out loud rather than guessing
 * a model on the trader's behalf.
 */
export const aiPreferences = sqliteTable("ai_preferences", {
  id: text("id").primaryKey(),
  chatProvider: text("chat_provider"),
  chatModel: text("chat_model"),
  chatReasoning: text("chat_reasoning"),
  updatedAt: integer("updated_at").notNull(),
})

// Protective levels for open positions. They outlive the process on purpose: a
// trailing stop that forgot its high-water mark would silently reopen risk the
// position had already walked away from.
export const stopRules = sqliteTable("stop_rules", {
  id: text("id").primaryKey(),
  instrumentUid: text("instrument_uid").notNull(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name").notNull(),
  side: text("side").notNull(),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  value: real("value").notNull(),
  basis: text("basis").notNull(),
  interval: text("interval"),
  quantity: integer("quantity"),
  status: text("status").notNull(),
  triggerPrice: real("trigger_price"),
  extremePrice: real("extreme_price"),
  referencePrice: real("reference_price"),
  atrValue: real("atr_value"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  triggeredAt: integer("triggered_at"),
  exitOrderUid: text("exit_order_uid"),
})

// Price levels the trader asked to be told about. Like stop rules they outlive
// the process, and for the same reason: a trailing alert that forgot its
// extreme would announce a move the market already made.
export const priceAlerts = sqliteTable("price_alerts", {
  id: text("id").primaryKey(),
  instrumentUid: text("instrument_uid").notNull(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name").notNull(),
  direction: text("direction").notNull(),
  kind: text("kind").notNull(),
  value: real("value").notNull(),
  basis: text("basis").notNull(),
  interval: text("interval"),
  // Alerts written before repeating existed fired once, which is what the
  // default preserves.
  repeat: text("repeat").notNull().default("ONCE"),
  status: text("status").notNull(),
  triggerPrice: real("trigger_price"),
  extremePrice: real("extreme_price"),
  referencePrice: real("reference_price"),
  atrValue: real("atr_value"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  triggeredAt: integer("triggered_at"),
  triggeredPrice: real("triggered_price"),
  chatSessionId: text("chat_session_id"),
  onTrigger: text("on_trigger"),
  triggerId: text("trigger_id"),
})

// Agent-owned conditions are deliberately separate from user price alerts. A
// monitor belongs to one chat and wakes that chat; it never appears in Alerts.
export const marketMonitors = sqliteTable("market_monitors", {
  id: text("id").primaryKey(),
  instrumentUid: text("instrument_uid").notNull(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name").notNull(),
  direction: text("direction").notNull(),
  kind: text("kind").notNull(),
  value: real("value").notNull(),
  basis: text("basis").notNull(),
  interval: text("interval"),
  repeat: text("repeat").notNull(),
  status: text("status").notNull(),
  triggerPrice: real("trigger_price"),
  extremePrice: real("extreme_price"),
  referencePrice: real("reference_price"),
  atrValue: real("atr_value"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  triggeredAt: integer("triggered_at"),
  triggeredPrice: real("triggered_price"),
  chatSessionId: text("chat_session_id").notNull(),
  onTrigger: text("on_trigger").notNull(),
  triggerId: text("trigger_id"),
})

export const appPreferences = sqliteTable("app_preferences", {
  id: integer("id").primaryKey(),
  instrumentSort: text("instrument_sort").notNull(),
  sortDirection: text("sort_direction").notNull(),
  candleRange: text("candle_range").notNull(),
  candleInterval: text("candle_interval").notNull(),
  chartTarget: text("chart_target").notNull().default("UNDERLYING"),
  depthTarget: text("depth_target").notNull().default("UNDERLYING"),
  // Comma-separated indicator names; empty means a bare price chart.
  chartIndicators: text("chart_indicators").notNull().default(""),
  selectedInstrumentUid: text("selected_instrument_uid"),
  orderKind: text("order_kind").notNull().default("LIMIT"),
  selectedMainChatSessionId: text("selected_main_chat_session_id"),
  selectedTradePanelChatSessionId: text("selected_trade_panel_chat_session_id"),
  selectedTradeRightView: text("selected_trade_right_view", { enum: TRADE_RIGHT_VIEWS }).notNull().default("news"),
  showChatThoughts: integer("show_chat_thoughts", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
})

// A conversation with the model. Sessions outlive the terminal that started them
// for the same reason stop rules do: the server, not a screen, is what runs them.
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  // New root chats start null under a timestamp placeholder. Auto is model-generated;
  // user is final. Legacy titles also remain null but cannot match a new placeholder.
  titleSource: text("title_source", { enum: ["auto", "user"] }),
  parentSessionId: text("parent_session_id"),
  agent: text("agent"),
  // Recorded per session so an old transcript still says what wrote it, even
  // after the chosen model changes. The provider and the reasoning level are
  // nullable because a session written before they existed names neither; such a
  // session takes the current default the next time it runs.
  model: text("model").notNull(),
  provider: text("provider"),
  reasoning: text("reasoning"),
  permissionMode: text("permission_mode", { enum: CHAT_PERMISSION_MODES }).notNull().default("MANUAL"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

// Agent notices remain pending across terminal disconnects until the user opens
// or dismisses them. Deleting their chat removes notices that can no longer open.
export const chatNotifications = sqliteTable(
  "chat_notifications",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    urgency: text("urgency").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("chat_notifications_created_at").on(table.createdAt)],
)

// Questions and permission prompts survive terminal disconnects and server
// restarts. Their owning agent run may be resumed directly or by a chat event.
export const chatQuestions = sqliteTable(
  "chat_questions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    questions: text("questions").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("chat_questions_created_at").on(table.createdAt)],
)

export const chatPermissionRequests = sqliteTable(
  "chat_permission_requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("chat_permission_requests_created_at").on(table.createdAt)],
)

// A private mobile account points at one active conversation. Pairing another chat
// moves that account instead of making an incoming message ambiguous.
export const chatMobileConnections = sqliteTable(
  "chat_mobile_connections",
  {
    sessionId: text("session_id").primaryKey().references(() => chatSessions.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalUserId: text("external_user_id").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    displayName: text("display_name").notNull(),
    connectedAt: integer("connected_at").notNull(),
    notificationsMuted: integer("notifications_muted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("chat_mobile_connections_external_user").on(table.channel, table.externalUserId),
  ],
)

// Unlike the connection, a turn outlives disconnect/reconnect so an old inline
// Undo button can still identify and remove the Telegram messages it represents.
export const chatMobileTurns = sqliteTable(
  "chat_mobile_turns",
  {
    promptMessageId: text("prompt_message_id").notNull(),
    sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalMessageIds: text("external_message_ids").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.promptMessageId, table.channel, table.externalChatId] }),
    index("chat_mobile_turns_session").on(table.sessionId),
  ],
)

// One current objective per root chat. Replacing a goal replaces this row.
export const chatGoals = sqliteTable("chat_goals", {
  sessionId: text("session_id").primaryKey().references(() => chatSessions.id, { onDelete: "cascade" }),
  id: text("id").notNull().unique(),
  objective: text("objective").notNull(),
  status: text("status").notNull(),
  turnCount: integer("turn_count").notNull(),
  maxTurns: integer("max_turns").notNull(),
  tokenBudget: integer("token_budget"),
  startedTokens: integer("started_tokens").notNull(),
  usedTokens: integer("used_tokens").notNull(),
  lastEvaluation: text("last_evaluation"),
  pendingEventKey: text("pending_event_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

// Scheduled prompts are durable and session-owned; missed intervals are coalesced.
export const chatLoops = sqliteTable(
  "chat_loops",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    usesDefaultPrompt: integer("uses_default_prompt", { mode: "boolean" }).notNull(),
    schedule: text("schedule").notNull(),
    intervalMs: integer("interval_ms"),
    cronExpression: text("cron_expression"),
    status: text("status").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    runCount: integer("run_count").notNull(),
    maxRuns: integer("max_runs"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("chat_loops_due").on(table.status, table.nextRunAt)],
)

/**
 * One message in a conversation, whether the trader wrote it, the model replied,
 * or a tool answered.
 *
 * The columns are a full mirror of what the model harness produced, not a summary
 * of it: replaying a session means handing the model back exactly what it said,
 * and a field that was not stored is a field that cannot be handed back. `extra`
 * carries anything a future harness version adds that this build does not model,
 * so an old row still replays exactly instead of quietly losing part of itself.
 *
 * `seq` is assigned when the row is written, queued messages included, so the
 * order of a conversation is fixed before anything is sent to the model and a
 * restart cannot reshuffle it.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    // The readable text of the message: what a transcript shows, and what makes a
    // conversation searchable in SQL. The blocks are what a turn is rebuilt from.
    text: text("text").notNull(),
    // Application events can show a compact fact in the transcript while giving
    // the model their full structured continuation.
    modelContent: text("model_content"),
    // A producer may retry after a crash; this keeps one durable event from
    // waking the same conversation twice.
    eventKey: text("event_key").unique(),
    api: text("api"),
    provider: text("provider"),
    model: text("model"),
    responseModel: text("response_model"),
    reasoning: text("reasoning"),
    // How long the model took over this reply, and how much of that went before its
    // first word. Measured by the agent around the stream, because the timestamps
    // either side of a queued message describe the wait rather than the thinking.
    elapsedMs: integer("elapsed_ms"),
    thinkingMs: integer("thinking_ms"),
    responseId: text("response_id"),
    stopReason: text("stop_reason"),
    errorMessage: text("error_message"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    totalTokens: integer("total_tokens"),
    costInput: real("cost_input"),
    costOutput: real("cost_output"),
    costCacheRead: real("cost_cache_read"),
    costCacheWrite: real("cost_cache_write"),
    costTotal: real("cost_total"),
    // Set on a tool result, naming the call it answers. `details` is whatever
    // structured result the tool returned, which is shapeless by contract.
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    isError: integer("is_error"),
    details: text("details"),
    // Successful mutations are kept outside the harness record: they are for
    // application rewind and must never become model context.
    effects: text("effects"),
    /** Which harness version wrote this row, for when a round trip starts failing. */
    harnessVersion: text("harness_version"),
    extra: text("extra"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("chat_messages_session_seq").on(table.sessionId, table.seq)],
)

// The complete transcript stays in chat_messages. This checkpoint only changes
// which prefix is replayed to the model and is replaced after each rolling summary.
export const chatCompactions = sqliteTable("chat_compactions", {
  sessionId: text("session_id").primaryKey().references(() => chatSessions.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  compactedThroughSeq: integer("compacted_through_seq").notNull(),
  firstKeptSeq: integer("first_kept_seq"),
  tokensBefore: integer("tokens_before").notNull(),
  tokensAfter: integer("tokens_after"),
  createdAt: integer("created_at").notNull(),
})

/**
 * The pieces of a message, in order.
 *
 * `signature` is one column because exactly one signature applies per kind — a
 * text signature, a thinking signature, or a tool call's thought signature. They
 * are as load-bearing as the text: a reasoning model handed its own signatures
 * back continues from the reasoning it already did, and without them it starts
 * over from the words alone.
 */
export const chatMessageBlocks = sqliteTable(
  "chat_message_blocks",
  {
    messageId: text("message_id").notNull(),
    idx: integer("idx").notNull(),
    kind: text("kind").notNull(),
    text: text("text"),
    signature: text("signature"),
    redacted: integer("redacted"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolArguments: text("tool_arguments"),
    mimeType: text("mime_type"),
    data: text("data"),
    extra: text("extra"),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.idx] })],
)

// Deduplicates mutating requests. A client retrying after a reconnect presents
// the same key, and the stored response is replayed instead of a second order
// reaching the provider.
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  route: text("route").notNull(),
  requestHash: text("request_hash").notNull(),
  /**
   * "COMPLETED" when `responseBody` is the answer to replay, or "IN_DOUBT" when
   * the attempt never reported one — a dropped connection leaves an order that
   * may or may not have reached the provider, and running it again could repeat
   * it. A key in doubt is refused rather than retried.
   */
  outcome: text("outcome").notNull().default("COMPLETED"),
  responseBody: text("response_body").notNull(),
  createdAt: integer("created_at").notNull(),
})
