import { expect, test } from "bun:test"
import type { GraphqlOperation } from "../api/graphql.ts"
import { ApiSettlementSource } from "./api-settlement.ts"

const settlementPayload = {
  settlementAnalysis: {
    calendar: {
      dateSet: ["2026-08-13", "2026-08-12"],
      presets: [
        { title: "Bugün", subtitle: null, start: "2026-08-13", end: null, isDefault: true, action: "SELECT" },
        { title: "Son 2 Gün", subtitle: "12-13 Ağustos", start: "2026-08-12", end: "2026-08-13", isDefault: false, action: "SELECT" },
        { title: "Tarih Seç", subtitle: null, start: null, end: null, isDefault: false, action: "CALENDAR" },
      ],
    },
    settlements: [
      { brokerage: "İş Yatırım", percentage: 15.67, percentageChange: -1.03, lotChange: -980_431, totalLot: null },
      { brokerage: "Midas", percentage: 11.09, percentageChange: -8.29, lotChange: -694_144, totalLot: null },
    ],
    type: "DOWN",
    topNSize: 5,
    topNPercentage: 53.79,
    topNLotChange: -3_366_613,
    otherLotChange: -2_891_872,
    dynamic: false,
    lastUpdate: "Son Güncelleme: 13 Ağustos 18:00",
    lastDateErrorMessage: "13 Ağustos takas verisi henüz yayınlanmadı.",
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
      return settlementPayload
    },
  }
  return { client, calls }
}

test("reads the settlement register for the stock behind the contract", async () => {
  const { client, calls } = fakeClient()
  const source = new ApiSettlementSource(client as never)

  const analysis = await source.loadSettlement({
    instrumentUid: "future-uid",
    mode: "LOST",
    range: { start: "2026-08-07", end: "2026-08-13" },
  })

  // The register covers cash equities, so the contract uid is resolved first.
  expect(calls[0]).toMatchObject({ name: "getInstrument", variables: { instrumentId: "future-uid" } })
  expect(calls[1]).toMatchObject({
    name: "settlementAnalysis",
    // The app's own mode names are traded for the provider's directions.
    variables: { uid: "stock-uid", settlementType: "DOWN", start: "2026-08-07", end: "2026-08-13" },
  })
  expect(analysis.holdings[0]).toEqual({
    brokerage: "İş Yatırım",
    percentage: 15.67,
    percentageChange: -1.03,
    lotChange: -980_431,
    totalLot: null,
  })
  expect(analysis).toMatchObject({ mode: "LOST", topCount: 5, topPercentage: 53.79, live: false })
  // The mode carries the direction, so the headline keeps the magnitude alone.
  expect(analysis.topLots).toBe(3_366_613)
  expect(analysis.otherLots).toBe(2_891_872)
  expect(analysis.unavailableMessage).toBe("13 Ağustos takas verisi henüz yayınlanmadı.")
  expect(analysis.availableDates).toEqual(["2026-08-13", "2026-08-12"])
})

test("asks for the standing positions under the held view", async () => {
  const { client, calls } = fakeClient()
  const source = new ApiSettlementSource(client as never)

  await source.loadSettlement({ instrumentUid: "future-uid", mode: "HELD", range: { start: null, end: null } })

  expect(calls[1]).toMatchObject({ name: "settlementAnalysis", variables: { settlementType: "TOTAL" } })
})

test("caches the underlying so repeated readings cost one query", async () => {
  const { client, calls } = fakeClient()
  const source = new ApiSettlementSource(client as never)

  await source.loadSettlement({ instrumentUid: "future-uid", mode: "GAINED", range: { start: null, end: null } })
  await source.loadSettlement({ instrumentUid: "future-uid", mode: "LOST", range: { start: null, end: null } })

  expect(calls.filter((call) => call.name === "getInstrument")).toHaveLength(1)
})

test("keeps only the presets that carry their own dates", async () => {
  const { client } = fakeClient()
  const source = new ApiSettlementSource(client as never)

  const analysis = await source.loadSettlement({
    instrumentUid: "future-uid",
    mode: "HELD",
    range: { start: null, end: null },
  })

  // "Tarih Seç" opens a calendar rather than naming a range, so it is dropped.
  expect(analysis.presets).toHaveLength(2)
  // The live session is served for a null range, which survives a day rollover.
  expect(analysis.presets[0]?.range).toEqual({ start: null, end: null })
  expect(analysis.presets[1]?.range).toEqual({ start: "2026-08-12", end: "2026-08-13" })
})
