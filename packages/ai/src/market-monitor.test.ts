import { expect, test } from "bun:test"
import {
  createMarketMonitor,
  type MarketMonitor,
  type MarketMonitorDraft,
} from "@trbot/market/market-monitor.ts"
import { FUTURES_INTERVALS_BY_RANGE, type CandleSeries } from "@trbot/market/candle.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { marketMonitorTools, type MarketMonitorToolClients } from "./market-monitor.ts"
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

function monitor(id = "monitor-1", instrument = ASELS, chatSessionId = "chat-1"): MarketMonitor {
  return createMarketMonitor({
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
    chatSessionId,
    onTrigger: "Reassess the breakout.",
  }, NOW)
}

function harness(seed: MarketMonitor[] = []) {
  const values = new Map(seed.map((item) => [item.id, item]))
  const drafts: MarketMonitorDraft[] = []
  const statuses: string[] = []
  const removed: string[] = []
  const service: MarketMonitorToolClients = {
    instruments: { listInstruments: async () => [ASELS, THYAO] },
    candles: { loadCandles: async (instrumentUid, range, interval) => candleSeries(instrumentUid, range, interval) },
    monitors: {
      list: async () => [...values.values()],
      save: async (draft) => {
        drafts.push(draft)
        const existing = draft.id ? values.get(draft.id) : undefined
        const created = createMarketMonitor(draft, NOW)
        const saved = existing
          ? {
              ...created,
              createdAt: existing.createdAt,
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

test("creates a durable agent-owned market monitor", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketMonitorTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_market_monitor",
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
  expect(outcome.blocks[0]?.text).toContain("Created market monitor")
})

test("refuses a level the current market has already crossed", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketMonitorTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_market_monitor",
    arguments: {
      symbol: "ASELS",
      direction: "ABOVE",
      kind: "PRICE",
      value: 390,
      onTrigger: "Reassess the breakout.",
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toBe(
    "ABOVE trigger 390 must be above the current F_ASELS0826 price of 400",
  )
  expect(testHarness.drafts).toHaveLength(0)
})

test("lists open market monitors with symbol and status filters", async () => {
  const asels = monitor()
  const thyao = { ...monitor("monitor-2", THYAO), status: "PAUSED" as const }
  const otherChat = monitor("monitor-3", ASELS, "chat-2")
  const closed = { ...monitor("monitor-4"), status: "TRIGGERED" as const }
  const tools = new ChatTools(marketMonitorTools(harness([asels, thyao, otherChat, closed]).service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "list-call",
    name: "list_market_monitors",
    arguments: { symbol: "thyao", status: "PAUSED" },
  }, { chatSessionId: "chat-1" })

  expect(outcome.blocks[0]?.text).toBe("Found 1 market monitor.")
  expect(outcome.modelBlocks?.[0]?.text).toContain("id: monitor-2")
  expect(outcome.modelBlocks?.[0]?.text).not.toContain("id: monitor-1")
  expect(outcome.modelBlocks?.[0]?.text).not.toContain("id: monitor-3")

  const all = await tools.call({
    type: "toolCall",
    id: "all-call",
    name: "list_market_monitors",
    arguments: {},
  }, { chatSessionId: "chat-1" })
  expect(all.blocks[0]?.text).toBe("Found 2 market monitors.")
  expect(all.modelBlocks?.[0]?.text).not.toContain("id: monitor-4")
})

test("updates a monitor without changing its owning chat", async () => {
  const testHarness = harness([monitor()])
  const tools = new ChatTools(marketMonitorTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "update-call",
    name: "update_market_monitor",
    arguments: { id: "monitor-1", kind: "PERCENT", value: 3, onTrigger: "Reassess the pullback." },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.drafts[0]).toMatchObject({
    id: "monitor-1",
    kind: "PERCENT",
    value: 3,
    referencePrice: 400,
    chatSessionId: "chat-1",
    onTrigger: "Reassess the pullback.",
  })
})

test("pauses, re-arms, and cancels market monitors", async () => {
  const testHarness = harness([monitor()])
  const tools = new ChatTools(marketMonitorTools(testHarness.service))

  const paused = await tools.call({
    type: "toolCall",
    id: "pause-call",
    name: "set_market_monitor_status",
    arguments: { id: "monitor-1", status: "PAUSED" },
  }, { chatSessionId: "chat-1" })
  const armed = await tools.call({
    type: "toolCall",
    id: "arm-call",
    name: "set_market_monitor_status",
    arguments: { id: "monitor-1", status: "ARMED" },
  }, { chatSessionId: "chat-1" })
  const deleted = await tools.call({
    type: "toolCall",
    id: "delete-call",
    name: "cancel_market_monitor",
    arguments: { id: "monitor-1" },
  }, { chatSessionId: "chat-1" })

  expect(paused.blocks[0]?.text).toBe("Paused market monitor monitor-1.")
  expect(armed.blocks[0]?.text).toBe("Armed market monitor monitor-1.")
  expect(deleted.blocks[0]?.text).toBe("Cancelled market monitor monitor-1 for ASELS.")
  expect(testHarness.statuses).toEqual(["monitor-1:PAUSED", "monitor-1:ARMED"])
  expect(testHarness.removed).toEqual(["monitor-1"])
})

test("refuses market-monitor mutations outside a chat", async () => {
  const testHarness = harness()
  const tools = new ChatTools(marketMonitorTools(testHarness.service))

  const outcome = await tools.call({
    type: "toolCall",
    id: "alert-call",
    name: "create_market_monitor",
    arguments: {
      symbol: "ASELS",
      direction: "ABOVE",
      kind: "PRICE",
      value: 420,
      onTrigger: "Reassess the breakout.",
    },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("must belong to a chat session")
  expect(testHarness.drafts).toHaveLength(0)
})

test("describes monitoring as durable attention, not trading authority", () => {
  const definitions = marketMonitorTools(harness().service).map((tool) => tool.definition)
  const create = definitions.find((definition) => definition.name === "create_market_monitor")

  expect(create?.description).toContain("without consuming model tokens")
  expect(create?.description).toContain("does not place orders")
  expect(create?.description).not.toContain("permission")
  expect(create?.description).toContain("refresh the required market and account data")
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
