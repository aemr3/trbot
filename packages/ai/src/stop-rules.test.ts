import { expect, test } from "bun:test"
import type { ChatPermissionAuthorizer } from "./permission.ts"
import type { CandleSeries } from "@trbot/market/candle.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import type { AccountSnapshot } from "@trbot/trading/account.ts"
import { createStopRule, type StopRule } from "@trbot/trading/stop.ts"
import { ChatTools } from "./tool.ts"
import { stopRuleTools, type StopRuleToolClients } from "./stop-rules.ts"

const NOW = 20_000_000
const INSTRUMENT: ViopInstrument = {
  uid: "instrument-1",
  symbol: "F_ASELS0826",
  displayName: "ASELS August 2026",
  underlyingSymbol: "ASELS",
  lastPrice: 100,
  changePercent: 1,
  volume: 10_000,
  currency: "TRY",
}
const ACCOUNT: AccountSnapshot = {
  portfolio: {
    currency: "TRY",
    totalCollateral: 100_000,
    availableCollateral: 50_000,
    dailyProfitLoss: 500,
    dailyProfitLossPercent: 0.5,
    periodProfitLoss: 500,
    periodProfitLossPercent: 0.5,
  },
  performance: { range: "WEEK", points: [], profitLoss: 500, profitLossPercent: 0.5 },
  orders: [],
  positions: [{
    uid: INSTRUMENT.uid,
    symbol: INSTRUMENT.symbol,
    displayName: INSTRUMENT.displayName,
    quantity: 3,
    averageCost: 98,
    currentPrice: 100,
    unrealizedProfitLoss: 600,
    currency: "TRY",
  }],
  updatedAt: NOW,
}
const CANDLES: CandleSeries = {
  instrumentUid: INSTRUMENT.uid,
  range: "INTRADAY",
  interval: "MIN_5",
  candles: Array.from({ length: 16 }, (_, index) => ({
    timestamp: index * 600_000,
    open: 98 + index * 0.1,
    high: 100 + index * 0.1,
    low: 97 + index * 0.1,
    close: 99 + index * 0.1,
    volume: 1_000,
  })),
  availableIntervalsByRange: {
    INTRADAY: ["MIN_5"],
    WEEK: ["HOUR_1"],
    MONTH: ["HOUR_4"],
    THREE_MONTH: ["DAY_1"],
    YEAR: ["DAY_1"],
    FIVE_YEAR: ["DAY_1"], ALL: ["DAY_1"]
  },
  intervalMs: 600_000,
  currency: "TRY",
}

function harness(permission: "ALLOW" | "DENY" = "ALLOW") {
  let rules: StopRule[] = []
  const permissionRequests: Parameters<ChatPermissionAuthorizer["authorize"]>[0][] = []
  const clients: StopRuleToolClients = {
    sources: () => ({
      instruments: { listInstruments: async () => [INSTRUMENT] },
      account: { loadAccount: async () => ACCOUNT },
      candles: { loadCandles: async () => CANDLES },
    }),
    rules: {
      list: async () => [...rules],
      save: async (draft) => {
        const saved = createStopRule(draft, NOW)
        const index = rules.findIndex((rule) => rule.id === saved.id)
        if (index >= 0) rules[index] = saved
        else rules.push(saved)
        return saved
      },
      setStatus: async (id, status) => {
        rules = rules.map((rule) => rule.id === id ? { ...rule, status } : rule)
      },
      remove: async (id) => { rules = rules.filter((rule) => rule.id !== id) },
    },
    permissions: {
      authorize: async (request) => {
        permissionRequests.push(request)
        return {
          decision: permission,
          reason: permission === "DENY" ? "Keep the existing protection" : null,
        }
      },
    },
    now: () => NOW,
  }
  return {
    clients,
    permissionRequests,
    rules: () => rules,
    seed(rule: StopRule) { rules.push(rule) },
  }
}

test("creates a server-managed protective exit after permission", async () => {
  const testHarness = harness()
  const tools = new ChatTools(stopRuleTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "stop-1",
    name: "create_stop_rule",
    arguments: {
      symbol: "ASELS",
      role: "STOP",
      kind: "PRICE",
      value: 95,
      basis: "TOUCH",
      quantity: 2,
      reason: "Cap the open position's loss",
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.permissionRequests).toEqual([expect.objectContaining({
    sessionId: "chat-1",
    toolName: "create_stop_rule",
    action: expect.stringContaining("STOP F_ASELS0826 at 95"),
    reason: "Cap the open position's loss",
    scope: "SESSION",
  })])
  expect(testHarness.rules()[0]).toMatchObject({
    symbol: INSTRUMENT.symbol,
    role: "STOP",
    kind: "PRICE",
    triggerPrice: 95,
    quantity: 2,
    status: "ARMED",
  })
})

test("derives ATR from contract candles instead of trusting a model-supplied value", async () => {
  const testHarness = harness()
  const tools = new ChatTools(stopRuleTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "stop-atr",
    name: "create_stop_rule",
    arguments: {
      symbol: INSTRUMENT.symbol,
      role: "STOP",
      kind: "TRAILING_ATR",
      value: 1.5,
      basis: "TOUCH",
      interval: "MIN_5",
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.rules()[0]?.atrValue).toBeGreaterThan(0)
})

test("returns the user's denial reason and leaves stop rules unchanged", async () => {
  const testHarness = harness("DENY")
  const tools = new ChatTools(stopRuleTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "stop-denied",
    name: "create_stop_rule",
    arguments: {
      symbol: "ASELS",
      role: "TARGET",
      kind: "PRICE",
      value: 105,
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]).toMatchObject({ text: expect.stringContaining("Keep the existing protection") })
  expect(testHarness.rules()).toEqual([])
})

test("updates, pauses, and deletes an existing rule through separate permissions", async () => {
  const testHarness = harness()
  const existing = createStopRule({
    id: "rule-1",
    instrumentUid: INSTRUMENT.uid,
    symbol: INSTRUMENT.symbol,
    displayName: INSTRUMENT.displayName,
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 95,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 98,
    atrValue: null,
  }, NOW)
  testHarness.seed(existing)
  const tools = new ChatTools(stopRuleTools(testHarness.clients))

  const updated = await tools.call({
    type: "toolCall",
    id: "stop-update",
    name: "update_stop_rule",
    arguments: { id: existing.id, value: 96 },
  }, { chatSessionId: "chat-1" })
  expect(updated.isError).toBe(false)
  expect(testHarness.rules()[0]?.triggerPrice).toBe(96)

  const paused = await tools.call({
    type: "toolCall",
    id: "stop-pause",
    name: "set_stop_rule_status",
    arguments: { id: existing.id, status: "PAUSED" },
  }, { chatSessionId: "chat-1" })
  expect(paused.isError).toBe(false)
  expect(testHarness.rules()[0]?.status).toBe("PAUSED")

  const removed = await tools.call({
    type: "toolCall",
    id: "stop-delete",
    name: "delete_stop_rule",
    arguments: { id: existing.id },
  }, { chatSessionId: "chat-1" })
  expect(removed.isError).toBe(false)
  expect(testHarness.rules()).toEqual([])
  expect(testHarness.permissionRequests.map((request) => request.toolName)).toEqual([
    "update_stop_rule",
    "set_stop_rule_status",
    "delete_stop_rule",
  ])
})

test("automated protective-exit changes allow a session-scoped permission", async () => {
  const testHarness = harness()
  const tools = new ChatTools(stopRuleTools(testHarness.clients))
  const outcome = await tools.call({
    type: "toolCall",
    id: "stop-analysis-only",
    name: "create_stop_rule",
    arguments: { symbol: "ASELS", role: "STOP", kind: "PRICE", value: 95 },
  }, {
    chatSessionId: "chat-1",
    automationEvent: { label: "goal", referenceId: "goal-1" },
  })

  expect(outcome.isError).toBe(false)
  expect(testHarness.permissionRequests).toEqual([expect.objectContaining({ scope: "SESSION" })])
  expect(testHarness.rules()).toHaveLength(1)
})
