import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

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

export const providerState = sqliteTable("provider_state", {
  providerId: text("provider_id").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: integer("expires_at").notNull(),
  accountId: text("account_id"),
  email: text("email"),
  createdAt: integer("created_at").notNull(),
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

export const watchlistPreferences = sqliteTable("watchlist_preferences", {
  id: integer("id").primaryKey(),
  instrumentSort: text("instrument_sort").notNull(),
  sortDirection: text("sort_direction").notNull(),
  candleRange: text("candle_range").notNull(),
  candleInterval: text("candle_interval").notNull(),
  chartTarget: text("chart_target").notNull().default("UNDERLYING"),
  selectedInstrumentUid: text("selected_instrument_uid"),
  orderKind: text("order_kind").notNull().default("LIMIT"),
  updatedAt: integer("updated_at").notNull(),
})
