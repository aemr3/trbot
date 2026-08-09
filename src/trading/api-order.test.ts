import { expect, test } from "bun:test"
import type { GraphqlOperation } from "../api/graphql.ts"
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

function fakeClient(calls: Array<{ name: string; variables: Record<string, unknown> }>, positionQuantity: number) {
  return {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData, TVariables extends Record<string, unknown>>(
      operation: GraphqlOperation<TData, TVariables>,
      variables: TVariables,
    ): Promise<TData> {
      calls.push({ name: operation.name, variables })
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
                : operation.name === "placeOrder"
                  ? { placeOrderV2: { order: { uid: "order-1", status: "PENDING", statusDescription: "Bekliyor" } } }
                  : null
      if (!response) throw new Error(`Unexpected operation ${operation.name}`)
      return response as TData
    },
  }
}
