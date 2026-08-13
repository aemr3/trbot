import { expect, test } from "bun:test"
import type { GraphqlOperation } from "../api/graphql.ts"
import { ApiBrokerageDistributionSource } from "./api-brokerage.ts"

const distributionPayload = {
  brokerageDistribution: {
    calendar: {
      dateSet: ["2026-08-13", "2026-08-12"],
      presets: [
        { title: "Bugün", subtitle: null, start: "2026-08-13", end: null, isDefault: true, action: "SELECT" },
        { title: "Son 2 Gün", subtitle: "12-13 Ağustos", start: "2026-08-12", end: "2026-08-13", isDefault: false, action: "SELECT" },
        { title: "Tarih Seç", subtitle: null, start: null, end: null, isDefault: false, action: "CALENDAR" },
      ],
    },
    distribution: [
      { brokerage: "Ak Yatırım", netShares: 1_669_647, cost: 386.41, percentage: 53.45 },
      { brokerage: "Bank Of America", netShares: 800_020, cost: 386.08, percentage: 25.61 },
    ],
    position: "BUYER",
    topNSize: 5,
    topNPercentage: 93.1,
    dynamic: true,
    topNShares: 2_907_973,
    otherShares: 215_732,
    lastUpdate: "Son Güncelleme: 13 Ağustos 15:37",
    sessionStatusEnabled: true,
  },
}

function fakeClient() {
  const calls: { name: string; variables: Record<string, unknown> }[] = []
  const client = {
    async call(operation: GraphqlOperation<unknown, never>, variables: Record<string, unknown>) {
      calls.push({ name: operation.name, variables })
      if (operation.name === "getInstrument") {
        return { instrument: { __typename: "Future", underlyingInstrumentUid: "stock-uid" } }
      }
      return distributionPayload
    },
  }
  return { client, calls }
}

test("reads the distribution for the stock behind the contract", async () => {
  const { client, calls } = fakeClient()
  const source = new ApiBrokerageDistributionSource(client as never)

  const distribution = await source.loadDistribution({
    instrumentUid: "future-uid",
    side: "BUYER",
    range: { start: "2026-08-12", end: "2026-08-13" },
  })

  // The provider only reports on cash equities, so the contract uid is resolved first.
  expect(calls[0]).toMatchObject({ name: "getInstrument", variables: { instrumentId: "future-uid" } })
  expect(calls[1]).toMatchObject({
    name: "brokerageDistribution",
    variables: { uid: "stock-uid", brokeragePosition: "BUYER", start: "2026-08-12", end: "2026-08-13" },
  })
  expect(distribution.shares[0]).toEqual({
    brokerage: "Ak Yatırım",
    netLots: 1_669_647,
    averagePrice: 386.41,
    percentage: 53.45,
  })
  expect(distribution).toMatchObject({ topCount: 5, topPercentage: 93.1, topLots: 2_907_973, otherLots: 215_732, live: true })
  expect(distribution.availableDates).toEqual(["2026-08-13", "2026-08-12"])
})

test("caches the underlying so repeated loads cost one query", async () => {
  const { client, calls } = fakeClient()
  const source = new ApiBrokerageDistributionSource(client as never)

  await source.loadDistribution({ instrumentUid: "future-uid", side: "BUYER", range: { start: null, end: null } })
  await source.loadDistribution({ instrumentUid: "future-uid", side: "SELLER", range: { start: null, end: null } })

  expect(calls.filter((call) => call.name === "getInstrument")).toHaveLength(1)
})

test("keeps only the presets that carry their own dates", async () => {
  const { client } = fakeClient()
  const source = new ApiBrokerageDistributionSource(client as never)

  const distribution = await source.loadDistribution({
    instrumentUid: "future-uid",
    side: "BUYER",
    range: { start: null, end: null },
  })

  // "Tarih Seç" opens a calendar rather than naming a range, so it is dropped.
  expect(distribution.presets).toHaveLength(2)
  // The live session is served for a null range, which survives a day rollover.
  expect(distribution.presets[0]?.range).toEqual({ start: null, end: null })
  expect(distribution.presets[1]?.range).toEqual({ start: "2026-08-12", end: "2026-08-13" })
})
