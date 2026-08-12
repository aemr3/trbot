import { expect, test } from "bun:test"
import type { GraphqlOperation } from "../api/graphql.ts"
import { tradingOperations } from "../api/trading.ts"
import { ApiViopOrderSource } from "./api-order.ts"

test("prepares a futures order with exchange limits, quote, collateral, and position intent", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const client = fakeClient(calls, 2)
  const source = new ApiViopOrderSource(client)

  const prepared = await source.prepareOrder({ instrumentUid: "future-1", side: "SELL" })

  expect(prepared).toEqual({
    lowerLimit: 188.3,
    upperLimit: 230.1,
    lastPrice: 209.55,
    ask: 210,
    bid: 209.55,
    priceScale: 2,
    contractSize: 100,
    initialCollateral: 4_719.55,
    availableCollateral: 45_000,
    currentPositionQuantity: 2,
    positionIntent: "SELL_TO_CLOSE",
  })
  expect(calls.find((call) => call.name === "prepareOrder")?.variables.positionIntent).toBe("SELL_TO_CLOSE")
})

test("submits futures trades as validated day limit orders", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const source = new ApiViopOrderSource(fakeClient(calls, 0))

  const placed = await source.placeOrder({ instrumentUid: "future-1", side: "BUY", quantity: 2, limitPrice: 230.1 })

  expect(placed).toEqual({ uid: "order-1", status: "PENDING", description: "Bekliyor" })
  expect(calls.find((call) => call.name === "placeOrder")?.variables).toMatchObject({
    instrumentId: "future-1",
    quantity: 2,
    limitPrice: 230.1,
    orderSide: "BUY",
    orderType: "LIMIT",
    timeInForce: "DAY",
    investmentType: "FUTURES",
    positionIntent: "BUY_TO_OPEN",
  })
})

test("rejects prices outside the prepared exchange limits", async () => {
  const source = new ApiViopOrderSource(fakeClient([], 0))
  expect(source.placeOrder({ instrumentUid: "future-1", side: "BUY", quantity: 1, limitPrice: 231 }))
    .rejects.toThrow("upper limit")
})

test("lists every pending futures order page and cancels each order", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const source = new ApiViopOrderSource(fakeClient(calls, 0))

  const orders = await source.listPendingOrders()
  const result = await source.cancelPendingOrders({ orderUids: orders.map((order) => order.uid) })

  expect(orders.map((order) => order.uid)).toEqual(["pending-1", "pending-2"])
  expect(result).toEqual({ cancelledOrderUids: ["pending-1", "pending-2"], failures: [] })
  expect(calls.filter((call) => call.name === "cancelOrder").map((call) => call.variables)).toEqual([
    { accountId: "try-account", orderId: "pending-1", instrumentId: null },
    { accountId: "try-account", orderId: "pending-2", instrumentId: null },
  ])
  expect(calls.filter((call) => call.name === "transactionHistoryForInvestmentType")).toHaveLength(2)
  expect(tradingOperations.cancelOrder.operationId)
    .toBe("dfe84cdc591a60e0b38ee2d54f4b31acacee29e744ad837cb42ed1ebfa5882a8")
})

test("continues cancelling remaining orders after an individual failure", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const source = new ApiViopOrderSource(fakeClient(calls, 0, "pending-1"))

  const result = await source.cancelPendingOrders({ orderUids: ["pending-1", "pending-2"] })

  expect(result).toEqual({
    cancelledOrderUids: ["pending-2"],
    failures: [{ orderUid: "pending-1", message: "Cancellation rejected" }],
  })
  expect(calls.filter((call) => call.name === "cancelOrder")).toHaveLength(2)
})

test("submits simulated-market close orders for every long and short VIOP position", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const source = new ApiViopOrderSource(fakeExitClient(calls))

  const result = await source.exitAllPositions()

  expect(result).toEqual({
    submitted: [
      { instrumentUid: "future-long", symbol: "F_LONG0826", quantity: 2, orderUid: "exit-future-long" },
      { instrumentUid: "future-short", symbol: "F_SHORT0826", quantity: 3, orderUid: "exit-future-short" },
    ],
    failures: [],
  })
  expect(calls.filter((call) => call.name === "placeOrder").map((call) => call.variables)).toEqual([
    expect.objectContaining({
      instrumentId: "future-long",
      quantity: 2,
      limitPrice: 188.3,
      orderSide: "SELL",
      orderType: "LIMIT",
      timeInForce: "DAY",
      positionIntent: "SELL_TO_CLOSE",
    }),
    expect.objectContaining({
      instrumentId: "future-short",
      quantity: 3,
      limitPrice: 230.1,
      orderSide: "BUY",
      orderType: "LIMIT",
      timeInForce: "DAY",
      positionIntent: "BUY_TO_CLOSE",
    }),
  ])
})

test("continues exiting remaining VIOP positions after an individual failure", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const source = new ApiViopOrderSource(fakeExitClient(calls, "future-long"))

  const result = await source.exitAllPositions()

  expect(result.submitted.map((entry) => entry.instrumentUid)).toEqual(["future-short"])
  expect(result.failures).toEqual([{
    instrumentUid: "future-long",
    symbol: "F_LONG0826",
    quantity: 2,
    message: "Exit rejected",
  }])
  expect(calls.filter((call) => call.name === "placeOrder")).toHaveLength(2)
})

function fakeClient(
  calls: Array<{ name: string; variables: Record<string, unknown> }>,
  positionQuantity: number,
  cancelFailureUid?: string,
) {
  return {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData, TVariables extends Record<string, unknown>>(
      operation: GraphqlOperation<TData, TVariables>,
      variables: TVariables,
    ): Promise<TData> {
      calls.push({ name: operation.name, variables })
      if (operation.name === "cancelOrder" && variables.orderId === cancelFailureUid) {
        throw new Error("Cancellation rejected")
      }
      const response = operation.name === "overviewV7"
        ? { overviewV7: { accounts: [{ accountUid: "try-account", status: "ACTIVE", currency: "TRY" }] } }
        : operation.name === "viopOverviewPositions"
          ? { viopOverviewPositions: { positions: [{ assetUid: "future-1", quantity: positionQuantity }] } }
          : operation.name === "assetFuture"
            ? { assetFuture: { multiplier: 100, tradePriceAndQuote: { ask: 210, bid: 209.55, futurePrice: 209.55 }, priceFormat: { scale: 2 } } }
            : operation.name === "prepareOrder"
              ? {
                  orderPreparationV2: {
                    type: "LIMIT",
                    availableOrderTypes: ["LIMIT"],
                    priceRange: { minPrice: 188.3, maxPrice: 230.1 },
                    initialCollateral: 4_719.55,
                    validityPeriodDto: {
                      tradingRangeDto: { validityPeriodCalendarItems: [{ isActive: true, timeInForce: "DAY" }] },
                    },
                  },
                }
              : operation.name === "accountViopMarginHealthDetail"
                ? { accountViopMarginHealthDetail: { availableCollateral: 45_000 } }
                : operation.name === "transactionHistoryForInvestmentType"
                  ? Number(variables.page) === 0
                    ? {
                        transactionHistoryForInvestmentType: {
                          items: [{ uid: "pending-1", detail: { title: "First order" } }],
                          hasMore: true,
                        },
                      }
                    : {
                        transactionHistoryForInvestmentType: {
                          items: [{ uid: "pending-2", detail: { title: "Second order" } }],
                          hasMore: false,
                        },
                      }
                  : operation.name === "cancelOrder"
                    ? { cancelOrder: { order: { uid: variables.orderId, status: "PENDING_CANCEL" } } }
                : operation.name === "placeOrder"
                  ? { placeOrderV2: { order: { uid: "order-1", status: "PENDING", statusDescription: "Bekliyor" } } }
                  : null
      if (!response) throw new Error(`Unexpected operation ${operation.name}`)
      return response as TData
    },
  }
}

function fakeExitClient(
  calls: Array<{ name: string; variables: Record<string, unknown> }>,
  failureInstrumentUid?: string,
) {
  return {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData, TVariables extends Record<string, unknown>>(
      operation: GraphqlOperation<TData, TVariables>,
      variables: TVariables,
    ): Promise<TData> {
      calls.push({ name: operation.name, variables })
      if (operation.name === "placeOrder" && variables.instrumentId === failureInstrumentUid) {
        throw new Error("Exit rejected")
      }
      const response = operation.name === "overviewV7"
        ? { overviewV7: { accounts: [{ accountUid: "try-account", status: "ACTIVE", currency: "TRY" }] } }
        : operation.name === "viopOverviewPositions"
          ? {
              viopOverviewPositions: {
                positions: [
                  { assetUid: "future-long", symbol: "F_LONG0826", quantity: 2 },
                  { assetUid: "future-short", symbol: "F_SHORT0826", quantity: -3 },
                ],
              },
            }
          : operation.name === "assetFuture"
            ? { assetFuture: { priceFormat: { scale: 2 } } }
            : operation.name === "prepareOrder"
              ? {
                  orderPreparationV2: {
                    type: "LIMIT",
                    availableOrderTypes: ["LIMIT"],
                    priceRange: { minPrice: 188.3, maxPrice: 230.1 },
                    validityPeriodDto: {
                      tradingRangeDto: { validityPeriodCalendarItems: [{ isActive: true, timeInForce: "DAY" }] },
                    },
                  },
                }
              : operation.name === "placeOrder"
                ? {
                    placeOrderV2: {
                      order: { uid: `exit-${String(variables.instrumentId)}`, status: "PENDING" },
                    },
                  }
                : null
      if (!response) throw new Error(`Unexpected operation ${operation.name}`)
      return response as TData
    },
  }
}
