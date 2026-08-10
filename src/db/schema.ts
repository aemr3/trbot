import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

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
