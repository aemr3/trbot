import { expect, test } from "bun:test"
import { providerApiClient, type ProviderTestRequest } from "@trbot/api/provider-client.test-fixture.ts"
import { tradingOperations } from "@trbot/api/trading.ts"
import { ApiViopOrderSource } from "./order.ts"
import { z } from "zod"

const RecordedVariablesSchema = z.object({
  orderId: z.string().nullable().optional(),
  instrumentId: z.string().nullable().optional(),
  page: z.number().optional(),
  quantity: z.number().optional(),
}).loose()

interface RecordedCall {
  name: string
  variables: ProviderTestRequest["variables"]
}

test("prepares a futures order with exchange limits, quote, collateral, and position intent", async () => {
  const calls: RecordedCall[] = []
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
  expect(calls.find((call) => call.name === "prepareOrder")?.variables).toMatchObject({
    positionIntent: "SELL_TO_CLOSE",
  })
})

test("submits futures trades as validated day limit orders", async () => {
  const calls: RecordedCall[] = []
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
  const calls: RecordedCall[] = []
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
  const calls: RecordedCall[] = []
  const source = new ApiViopOrderSource(fakeClient(calls, 0, "pending-1"))

  const result = await source.cancelPendingOrders({ orderUids: ["pending-1", "pending-2"] })

  expect(result).toEqual({
    cancelledOrderUids: ["pending-2"],
    failures: [{ orderUid: "pending-1", message: "Cancellation rejected" }],
  })
  expect(calls.filter((call) => call.name === "cancelOrder")).toHaveLength(2)
})

test("submits simulated-market close orders for every long and short VIOP position", async () => {
  const calls: RecordedCall[] = []
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
  const calls: RecordedCall[] = []
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

test("exits a single position, closing only what it holds", async () => {
  const calls: RecordedCall[] = []
  const source = new ApiViopOrderSource(fakeExitClient(calls))

  const submitted = await source.exitPosition({ instrumentUid: "future-short" })

  expect(submitted).toEqual({
    instrumentUid: "future-short",
    symbol: "F_SHORT0826",
    quantity: 3,
    orderUid: "exit-future-short",
  })
  // Covering a short buys at the upper limit; the long is left alone.
  expect(calls.filter((call) => call.name === "placeOrder").map((call) => call.variables)).toEqual([
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

test("caps a partial exit at the open quantity", async () => {
  const calls: RecordedCall[] = []
  const source = new ApiViopOrderSource(fakeExitClient(calls))

  expect(await source.exitPosition({ instrumentUid: "future-long", quantity: 1 })).toMatchObject({ quantity: 1 })
  // Asking for more than the position holds would open a reverse position.
  expect(await source.exitPosition({ instrumentUid: "future-long", quantity: 9 })).toMatchObject({ quantity: 2 })
  expect(calls.filter((call) => call.name === "placeOrder")
    .map((call) => RecordedVariablesSchema.parse(call.variables).quantity)).toEqual([1, 2])
})

test("refuses to exit a position that is no longer open", async () => {
  const calls: RecordedCall[] = []
  const source = new ApiViopOrderSource(fakeExitClient(calls))

  await expect(source.exitPosition({ instrumentUid: "future-gone" })).rejects.toThrow("Position is no longer open")
  expect(calls.filter((call) => call.name === "placeOrder")).toHaveLength(0)
})

function fakeClient(
  calls: RecordedCall[],
  positionQuantity: number,
  cancelFailureUid?: string,
) {
  return providerApiClient((call) => {
      calls.push({ name: call.operationName, variables: call.variables })
      const request = RecordedVariablesSchema.parse(call.variables)
      if (call.operationName === "cancelOrder" && request.orderId === cancelFailureUid) {
        throw new Error("Cancellation rejected")
      }
      const response = call.operationName === "overviewV7"
        ? { overviewV7: { accounts: [{ accountUid: "try-account", status: "ACTIVE", currency: "TRY" }] } }
          : call.operationName === "viopOverviewPositions"
          ? { viopOverviewPositions: { positions: [{ assetUid: "future-1", quantity: positionQuantity }] } }
          : call.operationName === "assetFuture"
            ? { assetFuture: { multiplier: 100, tradePriceAndQuote: { ask: 210, bid: 209.55, futurePrice: 209.55 }, priceFormat: { scale: 2 } } }
            : call.operationName === "prepareOrder"
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
              : call.operationName === "accountViopMarginHealthDetail"
                ? { accountViopMarginHealthDetail: { availableCollateral: 45_000 } }
                : call.operationName === "transactionHistoryForInvestmentType"
                  ? Number(request.page) === 0
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
                  : call.operationName === "cancelOrder"
                    ? { cancelOrder: { order: { uid: request.orderId, status: "PENDING_CANCEL" } } }
                : call.operationName === "placeOrder"
                  ? { placeOrderV2: { order: { uid: "order-1", status: "PENDING", statusDescription: "Bekliyor" } } }
                  : null
      if (!response) throw new Error(`Unexpected operation ${call.operationName}`)
      return response
  }, { memberUid: "member" })
}

function fakeExitClient(
  calls: RecordedCall[],
  failureInstrumentUid?: string,
) {
  return providerApiClient((call) => {
      calls.push({ name: call.operationName, variables: call.variables })
      const request = RecordedVariablesSchema.parse(call.variables)
      if (call.operationName === "placeOrder" && request.instrumentId === failureInstrumentUid) {
        throw new Error("Exit rejected")
      }
      const response = call.operationName === "overviewV7"
        ? { overviewV7: { accounts: [{ accountUid: "try-account", status: "ACTIVE", currency: "TRY" }] } }
        : call.operationName === "viopOverviewPositions"
          ? {
              viopOverviewPositions: {
                positions: [
                  { assetUid: "future-long", symbol: "F_LONG0826", quantity: 2 },
                  { assetUid: "future-short", symbol: "F_SHORT0826", quantity: -3 },
                ],
              },
            }
          : call.operationName === "assetFuture"
            ? { assetFuture: { priceFormat: { scale: 2 } } }
            : call.operationName === "prepareOrder"
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
              : call.operationName === "placeOrder"
                ? {
                    placeOrderV2: {
                      order: { uid: `exit-${String(request.instrumentId)}`, status: "PENDING" },
                    },
                  }
                : null
      if (!response) throw new Error(`Unexpected operation ${call.operationName}`)
      return response
  }, { memberUid: "member" })
}
