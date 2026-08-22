import { describe, expect, test } from "bun:test"
import type { ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"
import { FeedAwareInstrumentSource } from "./instrument-availability.ts"
import type { FeedInstrumentSource } from "./instruments.ts"

const CONTRACTS: ViopInstrument[] = [
  instrument("future-garan", "F_GARAN0826", "GARAN"),
  instrument("future-gold", "F_XAUTRYM0826", "XAUTRY"),
  instrument("future-usd", "F_USDTRY0826", "USDTRY"),
]

const brokerage: ViopInstrumentSource = {
  listInstruments: async () => CONTRACTS,
}

const feed: Pick<FeedInstrumentSource, "listInstruments" | "listFutures"> = {
  listInstruments: async () => [
    { symbol: "GARAN", title: "Garanti", kind: "equity", decimals: 2, session: "0955-1810" },
    { symbol: "USDTRY", title: "US Dollar", kind: "fx", decimals: 4, session: "0000-2400" },
  ],
  listFutures: async () => [
    { symbol: "F_GARAN0826", title: "GARAN 2026-08", underlying: "GARAN", contractMonth: "2026-08" },
    { symbol: "F_XAUTRYM0826", title: "XAUTRYM 2026-08", underlying: "XAUTRYM", contractMonth: "2026-08" },
    { symbol: "F_USDTRY0826", title: "USDTRY 2026-08", underlying: "USDTRY", contractMonth: "2026-08" },
  ],
}

describe("FeedAwareInstrumentSource", () => {
  test("distinguishes equity analytics, spot data, and futures-only contracts", async () => {
    const instruments = await new FeedAwareInstrumentSource(brokerage, feed).listInstruments()

    expect(instruments.map((entry) => [entry.symbol, entry.marketData])).toEqual([
      ["F_GARAN0826", {
        instrumentCandles: true,
        underlyingSymbol: "GARAN",
        underlyingKind: "equity",
        brokerAnalytics: true,
      }],
      ["F_XAUTRYM0826", {
        instrumentCandles: true,
        underlyingSymbol: null,
        underlyingKind: null,
        brokerAnalytics: false,
      }],
      ["F_USDTRY0826", {
        instrumentCandles: true,
        underlyingSymbol: "USDTRY",
        underlyingKind: "currency",
        brokerAnalytics: false,
      }],
    ])
  })

  test("marks a brokerage contract absent from the active feed collection unavailable", async () => {
    const source = new FeedAwareInstrumentSource({
      listInstruments: async () => [instrument("future-old", "F_GARAN1026", "GARAN")],
    }, feed)

    const [instrumentWithAvailability] = await source.listInstruments()

    expect(instrumentWithAvailability?.marketData).toEqual({
      instrumentCandles: false,
      underlyingSymbol: "GARAN",
      underlyingKind: "equity",
      brokerAnalytics: true,
    })
  })
})

function instrument(uid: string, symbol: string, underlyingSymbol: string): ViopInstrument {
  return {
    uid,
    symbol,
    displayName: underlyingSymbol,
    underlyingSymbol,
    lastPrice: 1,
    changePercent: 0,
    volume: 1,
    currency: "TRY",
  }
}
