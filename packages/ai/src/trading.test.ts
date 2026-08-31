import { expect, test } from "bun:test"
import type { ChatPermissionAuthorizer } from "./permission.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import type { AccountSnapshot } from "@trbot/trading/account.ts"
import type {
  CancelPendingViopOrdersRequest,
  ExitViopPositionRequest,
  PlaceViopOrderRequest,
} from "@trbot/trading/order.ts"
import { ChatTools } from "./tool.ts"
import { tradingTools, type TradingToolClients } from "./trading.ts"

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
  performance: {
    range: "WEEK",
    points: [],
    profitLoss: 500,
    profitLossPercent: 0.5,
  },
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
  updatedAt: 1_000,
}

function harness(allowed = true) {
  const permissionRequests: Parameters<ChatPermissionAuthorizer["authorize"]>[0][] = []
  const placed: PlaceViopOrderRequest[] = []
  const cancelled: CancelPendingViopOrdersRequest[] = []
  const exited: ExitViopPositionRequest[] = []
  let exitedAll = 0
  const clients: TradingToolClients = {
    sources: () => ({
      instruments: { listInstruments: async () => [INSTRUMENT] },
      account: { loadAccount: async () => ACCOUNT },
      orders: {
        prepareOrder: async ({ side }) => ({
          underlyingInstrumentUid: "underlying-1",
          lowerLimit: 90,
          upperLimit: 110,
          lastPrice: 100,
          ask: 100.1,
          bid: 99.9,
          priceScale: 2,
          contractSize: 100,
          initialCollateral: 1_000,
          availableCollateral: 50_000,
          currentPositionQuantity: 3,
          positionIntent: side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_CLOSE",
        }),
        placeOrder: async (request) => {
          placed.push(request)
          return { uid: "order-1", status: "PENDING", description: null }
        },
        listPendingOrders: async () => [{ uid: "order-2", title: "ASELS buy", description: null }],
        cancelPendingOrders: async (request) => {
          cancelled.push(request)
          return { cancelledOrderUids: request.orderUids, failures: [] }
        },
        exitPosition: async (request) => {
          exited.push(request)
          return {
            instrumentUid: request.instrumentUid,
            symbol: INSTRUMENT.symbol,
            quantity: request.quantity ?? 3,
            orderUid: "exit-1",
          }
        },
        exitAllPositions: async () => {
          exitedAll += 1
          return {
            submitted: [{
              instrumentUid: INSTRUMENT.uid,
              symbol: INSTRUMENT.symbol,
              quantity: 3,
              orderUid: "exit-all-1",
            }],
            failures: [],
          }
        },
      },
    }),
    permissions: {
      authorize: async (request) => {
        permissionRequests.push(request)
        return { decision: allowed ? "ALLOW" : "DENY", reason: null }
      },
    },
  }
  return { clients, permissionRequests, placed, cancelled, exited, exitedAll: () => exitedAll }
}

test("validates and pauses a live order at the session permission gate", async () => {
  const testHarness = harness()
  const tools = new ChatTools(tradingTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "trade-1",
    name: "place_viop_order",
    arguments: {
      symbol: "ASELS",
      side: "BUY",
      quantity: 2,
      orderKind: "MARKETABLE_LIMIT",
      reason: "Enter after the breakout",
    },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(testHarness.permissionRequests).toEqual([expect.objectContaining({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 2 F_ASELS0826 at 110 (MARKETABLE_LIMIT)",
    reason: "Enter after the breakout",
    scope: "SESSION",
  })])
  expect(testHarness.placed).toEqual([expect.objectContaining({
    instrumentUid: INSTRUMENT.uid,
    side: "BUY",
    quantity: 2,
    limitPrice: 110,
  })])
})

test("a denied permission returns a recoverable tool error without placing the order", async () => {
  const testHarness = harness(false)
  const tools = new ChatTools(tradingTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "trade-1",
    name: "place_viop_order",
    arguments: { symbol: "ASELS", side: "SELL", quantity: 1, orderKind: "LIMIT", limitPrice: 99 },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("user denied")
  expect(testHarness.placed).toEqual([])
})

test("an automated turn lets the user grant permission for the session", async () => {
  const testHarness = harness()
  const tools = new ChatTools(tradingTools(testHarness.clients))

  const outcome = await tools.call({
    type: "toolCall",
    id: "exit-1",
    name: "exit_viop_position",
    arguments: { symbol: "ASELS" },
  }, {
    chatSessionId: "chat-1",
    automationEvent: { label: "loop", referenceId: "loop-1" },
  })

  expect(outcome.isError).toBe(false)
  expect(testHarness.permissionRequests).toEqual([expect.objectContaining({ scope: "SESSION" })])
  expect(testHarness.exited).toHaveLength(1)
})

test("cancels listed orders and exits one or all positions through separate permissions", async () => {
  const testHarness = harness()
  const tools = new ChatTools(tradingTools(testHarness.clients))

  const cancelled = await tools.call({
    type: "toolCall",
    id: "cancel-1",
    name: "cancel_pending_viop_orders",
    arguments: { orderUids: ["order-2"] },
  }, { chatSessionId: "chat-1" })
  const exited = await tools.call({
    type: "toolCall",
    id: "exit-1",
    name: "exit_viop_position",
    arguments: { symbol: "ASELS", quantity: 2 },
  }, { chatSessionId: "chat-1" })
  const all = await tools.call({
    type: "toolCall",
    id: "exit-all-1",
    name: "exit_all_viop_positions",
    arguments: {},
  }, { chatSessionId: "chat-1" })

  expect([cancelled.isError, exited.isError, all.isError]).toEqual([false, false, false])
  expect(testHarness.cancelled[0]?.orderUids).toEqual(["order-2"])
  expect(testHarness.exited[0]).toMatchObject({ instrumentUid: INSTRUMENT.uid, quantity: 2 })
  expect(testHarness.exitedAll()).toBe(1)
  expect(testHarness.permissionRequests.map((request) => request.toolName)).toEqual([
    "cancel_pending_viop_orders",
    "exit_viop_position",
    "exit_all_viop_positions",
  ])
})
