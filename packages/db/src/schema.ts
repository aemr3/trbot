import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

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
 * Which model answers, for each of the two places one is asked.
 *
 * A single row. Every column is nullable and nothing stands behind them: null means
 * nobody has chosen yet, which the overview panel and the composer say out loud
 * rather than guessing a model on the trader's behalf.
 */
export const aiPreferences = sqliteTable("ai_preferences", {
  id: text("id").primaryKey(),
  overviewProvider: text("overview_provider"),
  overviewModel: text("overview_model"),
  overviewReasoning: text("overview_reasoning"),
  chatProvider: text("chat_provider"),
  chatModel: text("chat_model"),
  chatReasoning: text("chat_reasoning"),
  updatedAt: integer("updated_at").notNull(),
})

// One finished AI overview per instrument and horizon, so a reopened app shows
// the last reading instead of paying for a new one. `digest` holds the JSON the
// commentary was written from, which the next run compares against.
export const overviewSnapshots = sqliteTable(
  "overview_snapshots",
  {
    instrumentUid: text("instrument_uid").notNull(),
    mode: text("mode").notNull(),
    digest: text("digest").notNull(),
    commentary: text("commentary").notNull(),
    generatedAt: integer("generated_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instrumentUid, table.mode] })],
)

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

export const appPreferences = sqliteTable("app_preferences", {
  id: integer("id").primaryKey(),
  instrumentSort: text("instrument_sort").notNull(),
  sortDirection: text("sort_direction").notNull(),
  candleRange: text("candle_range").notNull(),
  candleInterval: text("candle_interval").notNull(),
  chartTarget: text("chart_target").notNull().default("UNDERLYING"),
  // Comma-separated indicator names; empty means a bare price chart.
  chartIndicators: text("chart_indicators").notNull().default(""),
  selectedInstrumentUid: text("selected_instrument_uid"),
  orderKind: text("order_kind").notNull().default("LIMIT"),
  selectedChatSessionId: text("selected_chat_session_id"),
  showChatThoughts: integer("show_chat_thoughts", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
})

// A conversation with the model. Sessions outlive the terminal that started them
// for the same reason stop rules do: the server, not a screen, is what runs them.
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  parentSessionId: text("parent_session_id"),
  agent: text("agent"),
  // Recorded per session so an old transcript still says what wrote it, even
  // after the chosen model changes. The provider and the reasoning level are
  // nullable because a session written before they existed names neither; such a
  // session takes the current default the next time it runs.
  model: text("model").notNull(),
  provider: text("provider"),
  reasoning: text("reasoning"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

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
    /** Which harness version wrote this row, for when a round trip starts failing. */
    harnessVersion: text("harness_version"),
    extra: text("extra"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("chat_messages_session_seq").on(table.sessionId, table.seq)],
)

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
