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

export const marketCandles = sqliteTable("market_candles", {
  instrumentUid: text("instrument_uid").notNull(),
  interval: text("interval").notNull(),
  timestamp: integer("timestamp").notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.instrumentUid, table.interval, table.timestamp] }),
  index("market_candles_interval_timestamp_idx").on(table.interval, table.timestamp),
])

export const reinforcementPolicies = sqliteTable("reinforcement_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  algorithm: text("algorithm").notNull(),
  featureVersion: text("feature_version").notNull(),
  featureNamesJson: text("feature_names_json").notNull(),
  configurationJson: text("configuration_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  costsJson: text("costs_json").notNull(),
  partitionsJson: text("partitions_json").notNull(),
  trainingJson: text("training_json").notNull(),
  validationJson: text("validation_json").notNull(),
  testJson: text("test_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("reinforcement_policies_created_idx").on(table.createdAt),
  index("reinforcement_policies_feature_created_idx").on(table.featureVersion, table.createdAt),
])

export const reinforcementExperiments = sqliteTable("reinforcement_experiments", {
  id: text("id").primaryKey(),
  featureVersion: text("feature_version").notNull(),
  cutoffDate: text("cutoff_date").notNull(),
  policyId: text("policy_id").references(() => reinforcementPolicies.id, { onDelete: "cascade" }),
  artifactJson: text("artifact_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("reinforcement_experiments_created_idx").on(table.createdAt),
  index("reinforcement_experiments_feature_cutoff_idx").on(table.featureVersion, table.cutoffDate),
])
