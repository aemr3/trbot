import { expect, test } from "bun:test"
import { marketOperations, type ScreenerResult } from "../api/market.ts"
import { ApiViopInstrumentSource } from "./api-source.ts"

interface Op {
  name: string
}

function instrument(
  uid: string,
  symbol: string,
  underlying: string,
  price: string,
  change: string,
  redemptionDate?: string,
  volume = "1.234.567",
) {
  return {
    uid,
    symbol,
    values: [
      { key: "underlyingInstrumentSymbol", value: underlying, situation: "NEUTRAL" },
      { key: "price", value: price, situation: "NEUTRAL" },
      { key: "percentageChangeDay", value: change, situation: "NEUTRAL" },
      { key: "derivativeVolume", value: volume, situation: "NEUTRAL" },
      ...(redemptionDate ? [{ key: "redemptionDate", value: redemptionDate, situation: "NEUTRAL" }] : []),
    ],
  }
}

function fakeClient(pages: ScreenerResult[]) {
  const calls: { screener: number; result: number } = { screener: 0, result: 0 }
  let page = 0
  const client = {
    call(op: Op) {
      if (op.name === marketOperations.screenerRetrieveV2.name) {
        calls.screener++
        return Promise.resolve({
          screenerRetrieveV2: {
            uid: "default_TR_FUTURES",
            result: { pitId: "pit-1", searchAfter: null, totalSize: pages[0]?.totalSize ?? 0, sortBy: "stats.volume", sortDirection: "DESC", instruments: [] },
          },
        })
      }
      calls.result++
      const current = pages[page++]
      return Promise.resolve({ screenerRetrieveResultV2: current })
    },
  }
  return { client, calls }
}

test("aggregates all pages, dedupes by uid, and parses Turkish-formatted values", async () => {
  const pages: ScreenerResult[] = [
    {
      pitId: "pit-1",
      searchAfter: "cursor-1",
      totalSize: 3,
      sortBy: "stats.volume",
      sortDirection: "DESC",
      instruments: [
        instrument("u1", "F_XU0300826", "XU030", "₺11.842,50", "%0,86"),
        instrument("u2", "F_USDTRY0826", "USDTRY", "₺41,32", "-%0,12"),
      ],
    },
    {
      pitId: "pit-1",
      searchAfter: null,
      totalSize: 3,
      sortBy: "stats.volume",
      sortDirection: "DESC",
      instruments: [
        instrument("u2", "F_USDTRY0826", "USDTRY", "₺41,32", "-%0,12"), // duplicate across pages
        instrument("u3", "F_EREGL0826", "EREGL", "₺52,80", "-%7,03"),
      ],
    },
  ]

  const { client, calls } = fakeClient(pages)
  const source = new ApiViopInstrumentSource(client as never)
  const instruments = await source.listInstruments()

  expect(instruments.map((i) => i.uid)).toEqual(["u1", "u2", "u3"])
  expect(calls.screener).toBe(1)
  expect(calls.result).toBe(2)

  const xu030 = instruments[0]
  expect(xu030?.symbol).toBe("F_XU0300826")
  expect(xu030?.underlyingSymbol).toBe("XU030")
  expect(xu030?.displayName).toBe("XU030")
  expect(xu030?.lastPrice).toBe(11842.5)
  expect(xu030?.changePercent).toBe(0.86)
  expect(xu030?.volume).toBe(1_234_567)

  const usdtry = instruments[1]
  expect(usdtry?.lastPrice).toBe(41.32)
  expect(usdtry?.changePercent).toBe(-0.12)
})

test("keeps only the nearest-expiry contract per underlying", async () => {
  const pages: ScreenerResult[] = [
    {
      pitId: "pit-1",
      searchAfter: null,
      totalSize: 4,
      sortBy: "stats.volume",
      sortDirection: "DESC",
      instruments: [
        instrument("u-usd-09", "F_USDTRY0926", "USDTRY", "₺41,50", "%0,10", "30/09/26"),
        instrument("u-usd-08", "F_USDTRY0826", "USDTRY", "₺41,32", "-%0,12", "31/08/26"),
        instrument("u-usd-10", "F_USDTRY1026", "USDTRY", "₺41,70", "%0,20", "31/10/26"),
        instrument("u-xu-08", "F_XU0300826", "XU030", "₺15.900,00", "%0,40", "31/08/26"),
      ],
    },
  ]

  const { client } = fakeClient(pages)
  const source = new ApiViopInstrumentSource(client as never)
  const instruments = await source.listInstruments()

  expect(instruments.map((i) => i.symbol)).toEqual(["F_USDTRY0826", "F_XU0300826"])
})

test("stops paginating when totalSize is reached", async () => {
  const pages: ScreenerResult[] = [
    {
      pitId: "pit-1",
      searchAfter: "cursor-1",
      totalSize: 1,
      sortBy: "stats.volume",
      sortDirection: "DESC",
      instruments: [instrument("u1", "F_XU0300826", "XU030", "₺100,00", "%1,00")],
    },
  ]
  const { client, calls } = fakeClient(pages)
  const source = new ApiViopInstrumentSource(client as never)
  const instruments = await source.listInstruments()

  expect(instruments).toHaveLength(1)
  expect(calls.result).toBe(1)
})

test("loads and normalizes contract details and statistics", async () => {
  const client = {
    call(op: Op, variables: Record<string, unknown>) {
      expect(op.name).toBe(marketOperations.futureDetail.name)
      expect(variables).toEqual({ instrumentUid: "future-1" })
      return Promise.resolve({
        futureDetail: {
          contractDetails: {
            title: "Kontrat Detayları",
            description: null,
            items: [
              { key: "ic", text: "Başlangıç teminatı", value: "₺7.991,91", info: null },
              { key: "lv", text: "Kaldıraç", value: "4,11", info: null },
              { key: "un", text: "Sözleşme büyüklüğü", value: "100", info: null },
              { key: "rd", text: "Vade sonu", value: "31/08/2026", info: null },
            ],
          },
          stats: {
            title: "İstatistikler",
            description: null,
            items: [
              { key: "En yüksek", text: "En yüksek", value: "₺338,15", info: null },
              { key: "En düşük", text: "En düşük", value: "₺324,55", info: null },
              { key: "sp", text: "Uzlaşma fiyatı", value: "₺328,75", info: null },
              { key: "psp", text: "Önceki uzlaşma", value: "₺328,85", info: null },
              { key: "vo", text: "Hacim", value: "3.996.802.304,00", info: null },
              { key: "oi", text: "Açık Pozisyon", value: "170.108", info: null },
            ],
          },
        },
      })
    },
  }

  const details = await new ApiViopInstrumentSource(client as never).loadContractDetails("future-1")

  expect(details).toEqual({
    initialCollateral: 7_991.91,
    leverage: 4.11,
    contractSize: 100,
    expiryDate: "31/08/2026",
    sessionHigh: 338.15,
    sessionLow: 324.55,
    settlementPrice: 328.75,
    previousSettlementPrice: 328.85,
    volume: 3_996_802_304,
    openInterest: 170_108,
  })
})
