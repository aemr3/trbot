import { expect, test } from "bun:test"
import type { GraphqlOperation } from "@trbot/api/graphql.ts"
import { ApiAccountSource, normalizeOrders, normalizePerformance, normalizePosition } from "./account.ts"

test("loads the TRY portfolio with VIOP orders and positions", async () => {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = []
  const responses: Record<string, unknown[]> = {
    overviewV7: [{
      overviewV7: {
        accounts: [
          { accountUid: "usd", status: "ACTIVE", currency: "USD" },
          { accountUid: "try", status: "ACTIVE", currency: "TRY" },
        ],
      },
    }],
    viopRealizedProfitLoss: [{
      viopRealizedProfitLoss: {
        totalCollateral: 125_000,
        dailyProfitLoss: { value: 2_500, percentage: 2.04 },
        profitLoss: { value: 5_000, percentage: 4.17 },
      },
    }],
    accountViopMarginHealthDetail: [{ accountViopMarginHealthDetail: { availableCollateral: 45_000 } }],
    viopOverviewPositions: [{
      viopOverviewPositions: {
        positions: [{
          assetUid: "future-1",
          symbol: "F_THYAO0826",
          displayName: "THYAO Ağustos",
          quantity: "2",
          averageCost: "300",
          currency: "TRY",
          multiplier: 10,
          tradePriceV3: { price: 312, extendedPrice: null },
        }],
      },
    }],
    transactionHistoryForInvestmentType: [
      {
        transactionHistoryForInvestmentType: {
          items: [{
            uid: "pending-1",
            typeV2: "ORDER",
            detail: {
              title: "THYAO alış",
              titleDescription: { description: "2 kontrat" },
              listDetailTrailing: { text: "Bekliyor" },
            },
          }],
        },
      },
      {
        transactionHistoryForInvestmentType: {
          items: [{ uid: "done-1", typeV2: "ORDER", detail: { title: "EREGL satış" } }],
        },
      },
    ],
  }
  const client = {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData, TVariables extends Record<string, unknown>>(
      operation: GraphqlOperation<TData, TVariables>,
      variables: TVariables,
    ): Promise<TData> {
      calls.push({ name: operation.name, variables })
      const response = responses[operation.name]?.shift()
      if (!response) throw new Error(`Missing response for ${operation.name}`)
      return response as TData
    },
  }

  const source = new ApiAccountSource(client, () => 1234)
  const snapshot = await source.loadAccount()

  expect(snapshot.portfolio).toEqual({
    currency: "TRY",
    totalCollateral: 125_000,
    availableCollateral: 45_000,
    dailyProfitLoss: 2_500,
    dailyProfitLossPercent: 2.04,
    periodProfitLoss: 5_000,
    periodProfitLossPercent: 4.17,
  })
  expect(snapshot.positions[0]).toMatchObject({
    symbol: "F_THYAO0826",
    quantity: 2,
    currentPrice: 312,
    unrealizedProfitLoss: 240,
  })
  expect(snapshot.orders.map((order) => order.status)).toEqual(["pending", "completed"])
  expect(snapshot.updatedAt).toBe(1234)
  expect(calls.filter((call) => call.name === "transactionHistoryForInvestmentType").map((call) => call.variables.status))
    .toEqual(["PENDING", "COMPLETED"])
  expect(calls.find((call) => call.name === "viopOverviewPositions")?.variables.accountId).toBe("member")
})

test("drops malformed provider rows without losing valid account data", () => {
  expect(normalizePosition({ assetUid: "missing-symbol", quantity: 2 })).toEqual([])
  expect(normalizeOrders([{ uid: null }, { uid: "valid", typeV2: "ORDER" }], "pending")).toEqual([{
    uid: "valid",
    title: "ORDER",
    description: null,
    value: null,
    status: "pending",
  }])
})

test("keeps the real performance bars and drops the padded ones", () => {
  const performance = normalizePerformance(
    {
      viopRealizedProfitLoss: {
        profitLoss: { value: 695.43, percentage: 3.5455 },
        profitLossChart: {
          maxCount: 6,
          timeRange: "YEAR",
          dataPoints: [
            // Padding the provider invents to fill six slots: no date, no
            // collateral, and a made-up figure. Drawing these would be drawing
            // history that never happened.
            { date: null, totalCollateral: 0, profitLoss: { value: 23.21, percentage: 0 }, virtual: true },
            { date: null, totalCollateral: 0, profitLoss: { value: 46.42, percentage: 0 }, virtual: true },
            { date: "2026-08-07", totalCollateral: 19_324.18, profitLoss: { value: -1_490, percentage: -7.15 }, virtual: false },
            { date: "2026-08-14", totalCollateral: 22_045.07, profitLoss: { value: 2_979.33, percentage: 14.7 }, virtual: false },
          ],
        },
      },
    },
    "YEAR",
  )

  expect(performance.range).toBe("YEAR")
  expect(performance.profitLoss).toBe(695.43)
  expect(performance.points).toEqual([
    { date: "2026-08-07", profitLoss: -1_490, profitLossPercent: -7.15, totalCollateral: 19_324.18 },
    { date: "2026-08-14", profitLoss: 2_979.33, profitLossPercent: 14.7, totalCollateral: 22_045.07 },
  ])
})

test("reads performance for the range it was asked for", async () => {
  const variables: Array<Record<string, unknown>> = []
  const client = {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData>(operation: GraphqlOperation<TData>, vars: Record<string, unknown>): Promise<TData> {
      variables.push({ name: operation.name, ...vars })
      if (operation.name === "overviewV7") {
        return { overviewV7: { accounts: [{ accountUid: "try", status: "ACTIVE", currency: "TRY" }] } } as TData
      }
      return {} as TData
    },
  }

  const snapshot = await new ApiAccountSource(client).loadAccount({ portfolioRange: "THREE_MONTH" })

  // The provider takes the member uid here; an account uid is refused outright.
  const portfolio = variables.find((entry) => entry.name === "viopRealizedProfitLoss")
  expect(portfolio).toMatchObject({ accountId: "member", period: "THREE_MONTH" })
  expect(snapshot.performance.range).toBe("THREE_MONTH")
})

test("fails clearly when there is no active TRY account", async () => {
  const client = {
    async authenticate() {
      return { accessToken: "token", refreshToken: null, memberUid: "member" }
    },
    async call<TData>(): Promise<TData> {
      return { overviewV7: { accounts: [{ accountUid: "usd", status: "ACTIVE", currency: "USD" }] } } as TData
    },
  }

  expect(new ApiAccountSource(client).loadAccount()).rejects.toThrow("No active TRY investment account")
})
