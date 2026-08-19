import { expect, test } from "bun:test"
import { createPriceAlert, type PriceAlert, type PriceAlertDraft } from "@trbot/market/alert.ts"
import { FUTURES_INTERVALS_BY_RANGE, type CandleSeries } from "@trbot/market/candle.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { priceAlertTools, type PriceAlertToolClients } from "./price-alert.ts"
import { ChatTools } from "./tool.ts"

const NOW = 1_786_000_000_000
const ASELS: ViopInstrument = {
  uid: "instrument-1",
  symbol: "F_ASELS0826",
  displayName: "ASELS",
  underlyingSymbol: "ASELS",
  lastPrice: 400,
  changePercent: 1,
  volume: 10_000,
  currency: "TRY",
}
const THYAO: ViopInstrument = {
  ...ASELS,
  uid: "instrument-2",
  symbol: "F_THYAO0826",
  displayName: "THYAO",
  underlyingSymbol: "THYAO",
  lastPrice: 300,
}

function alert(id = "alert-1", instrument = ASELS): PriceAlert {
  return createPriceAlert({
    id,
    instrumentUid: instrument.uid,
    symbol: instrument.symbol,
    displayName: instrument.displayName,
    direction: "ABOVE",
    kind: "PRICE",
    value: (instrument.lastPrice ?? 400) + 20,
    basis: "TOUCH",
    interval: null,
    repeat: "ONCE",
    referencePrice: instrument.lastPrice,
    atrValue: null,
    chatSessionId: "chat-1",
    onTrigger: "Reassess the breakout.",
  }, NOW)
}

function harness(seed: PriceAlert[] = []) {
  const values = new Map(seed.map((item) => [item.id, item]))
  const drafts: PriceAlertDraft[] = []
  const statuses: string[] = []
  const removed: string[] = []
  const service: PriceAlertToolClients = {
    instruments: { listInstruments: async () => [ASELS, THYAO] },
    candles: { loadCandles: async (instrumentUid, range, interval) => candleSeries(instrumentUid, range, interval) },
    alerts: {
      list: async () => [...values.values()],
      save: async (draft) => {
        drafts.push(draft)
        const existing = draft.id ? values.get(draft.id) : undefined
        const created = createPriceAlert(draft, NOW)
        const saved = existing
          ? {
              ...created,
              createdAt: existing.createdAt,
              chatSessionId: draft.chatSessionId === undefined ? existing.chatSessionId : created.chatSessionId,
              onTrigger: draft.onTrigger === undefined ? existing.onTrigger : created.onTrigger,
            }
          : created
        values.set(saved.id, saved)
        return saved
      },
      setStatus: async (id, status) => {
        const existing = values.get(id)
        if (existing) values.set(id, { ...existing, status })
        statuses.push(`${id}:${status}`)
      },
      remove: async (id) => {
        values.delete(id)
        removed.push(id)
      },
    },
    now: () => NOW,
  }
  return { service, drafts, statuses, removed }
}

test("creates every alert shape through the same draft contract as the terminal", async () => {
  const testHarness = harness()
  const tools = new ChatTools(priceAlertTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_price_alert",
    arguments: {
      symbol: " ASELS ",
      direction: "BELOW",
      kind: "TRAILING_ATR",
      value: 2,
      basis: "CLOSE",
      interval: "HOUR_1",
      repeat: "ALWAYS",
      onTrigger: " Reassess whether the trend has broken. ",
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.drafts[0]).toMatchObject({
    instrumentUid: ASELS.uid,
    symbol: ASELS.symbol,
    direction: "BELOW",
    kind: "TRAILING_ATR",
    value: 2,
    basis: "CLOSE",
    interval: "HOUR_1",
    repeat: "ALWAYS",
    referencePrice: 400,
    atrValue: 2,
    chatSessionId: "chat-1",
    onTrigger: "Reassess whether the trend has broken.",
  })
  expect(outcome.blocks[0]?.text).toContain("Created alert")
})

test("refuses a level the current market has already crossed", async () => {
  const testHarness = harness()
  const tools = new ChatTools(priceAlertTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_price_alert",
    arguments: { symbol: "ASELS", direction: "ABOVE", kind: "PRICE", value: 390 },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toBe(
    "ABOVE trigger 390 must be above the current F_ASELS0826 price of 400",
  )
  expect(testHarness.drafts).toHaveLength(0)
})

test("lists alerts with symbol and status filters", async () => {
  const asels = alert()
  const thyao = { ...alert("alert-2", THYAO), status: "PAUSED" as const }
  const tools = new ChatTools(priceAlertTools(harness([asels, thyao]).service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "list-call",
    name: "list_price_alerts",
    arguments: { symbol: "thyao", status: "PAUSED" },
  }, { chatSessionId: "chat-1" })

  expect(outcome.blocks[0]?.text).toBe("Found 1 price alert.")
  expect(outcome.modelBlocks?.[0]?.text).toContain("id: alert-2")
  expect(outcome.modelBlocks?.[0]?.text).not.toContain("id: alert-1")
})

test("updates a terminal-style draft and can remove its chat continuation", async () => {
  const testHarness = harness([alert()])
  const tools = new ChatTools(priceAlertTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "update-call",
    name: "update_price_alert",
    arguments: { id: "alert-1", kind: "PERCENT", value: 3, onTrigger: null },
  }, { chatSessionId: "chat-2" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.drafts[0]).toMatchObject({
    id: "alert-1",
    kind: "PERCENT",
    value: 3,
    referencePrice: 400,
    chatSessionId: null,
    onTrigger: null,
  })
})

test("pauses, re-arms, and deletes alerts through the shared alert actions", async () => {
  const testHarness = harness([alert()])
  const tools = new ChatTools(priceAlertTools(testHarness.service))

  const paused = await tools.call({
    type: "toolCall",
    id: "pause-call",
    name: "set_price_alert_status",
    arguments: { id: "alert-1", status: "PAUSED" },
  }, { chatSessionId: "chat-1" })
  const armed = await tools.call({
    type: "toolCall",
    id: "arm-call",
    name: "set_price_alert_status",
    arguments: { id: "alert-1", status: "ARMED" },
  }, { chatSessionId: "chat-1" })
  const deleted = await tools.call({
    type: "toolCall",
    id: "delete-call",
    name: "delete_price_alert",
    arguments: { id: "alert-1" },
  }, { chatSessionId: "chat-1" })

  expect(paused.blocks[0]?.text).toBe("Paused alert alert-1.")
  expect(armed.blocks[0]?.text).toBe("Armed alert alert-1.")
  expect(deleted.blocks[0]?.text).toBe("Deleted alert alert-1 for ASELS.")
  expect(testHarness.statuses).toEqual(["alert-1:PAUSED", "alert-1:ARMED"])
  expect(testHarness.removed).toEqual(["alert-1"])
})

test("refuses alert mutations outside a chat", async () => {
  const testHarness = harness()
  const tools = new ChatTools(priceAlertTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_price_alert",
    arguments: { symbol: "ASELS", direction: "ABOVE", kind: "PRICE", value: 420 },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("must belong to a chat session")
  expect(testHarness.drafts).toHaveLength(0)
})

function candleSeries(
  instrumentUid: string,
  range: CandleSeries["range"],
  interval: CandleSeries["interval"],
): CandleSeries {
  return {
    instrumentUid,
    range,
    interval,
    candles: Array.from({ length: 16 }, (_, index) => ({
      timestamp: NOW - (20 - index) * 3_600_000,
      open: 400,
      high: 401,
      low: 399,
      close: 400,
      volume: 1_000,
    })),
    availableIntervalsByRange: FUTURES_INTERVALS_BY_RANGE,
    intervalMs: 3_600_000,
    currency: "TRY",
  }
}
