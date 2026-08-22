import { describe, expect, test } from "bun:test"
import type { CandleChartTarget, CandleInterval, CandleRange, CandleSeries, CandleSource } from "@trbot/market/candle.ts"
import type { ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"
import { InstrumentCandleSource } from "./instrument-candles.ts"
import { InstrumentSymbols } from "./instrument-symbols.ts"

const INSTRUMENTS: ViopInstrument[] = [
  {
    uid: "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da",
    symbol: "F_THYAO0826",
    displayName: "THYAO",
    underlyingSymbol: "THYAO",
    lastPrice: 312.45,
    changePercent: -1.05,
    volume: 1_000,
    currency: "TRY",
  },
  {
    uid: "viop-ftr-index",
    symbol: "F_XU0300826",
    displayName: "XU030",
    underlyingSymbol: "XU030",
    lastPrice: 16_821,
    changePercent: 0.4,
    volume: 2_000,
    currency: "TRY",
  },
]

function build(instruments: ViopInstrument[] = INSTRUMENTS) {
  const asked: { symbol: string; range: CandleRange; interval: CandleInterval }[] = []
  let listCalls = 0

  const candles: CandleSource = {
    async loadCandles(symbol, range, interval): Promise<CandleSeries> {
      asked.push({ symbol, range, interval })
      return {
        instrumentUid: symbol,
        range,
        interval,
        candles: [],
        availableIntervalsByRange: {
          INTRADAY: [], WEEK: [], MONTH: [], THREE_MONTH: [], YEAR: [], FIVE_YEAR: [], ALL: []
        },
        intervalMs: null,
        currency: "TRY",
      }
    },
  }

  const source: ViopInstrumentSource = {
    async listInstruments(): Promise<ViopInstrument[]> {
      listCalls++
      return instruments
    },
  }

  return {
    asked,
    listCalls: () => listCalls,
    subject: new InstrumentCandleSource(candles, new InstrumentSymbols(source)),
  }
}

async function load(
  subject: InstrumentCandleSource,
  uid: string,
  target?: CandleChartTarget,
): Promise<CandleSeries> {
  return subject.loadCandles(uid, "INTRADAY", "MIN_5", target ? { target } : {})
}

describe("InstrumentCandleSource", () => {
  /**
   * The failure this exists to prevent: a brokerage uid sent to the feed as a
   * ticker, which the feed answers with HTTP 400.
   */
  test("translates a brokerage uid into the feed's ticker", async () => {
    const { subject, asked } = build()
    await load(subject, "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da")

    expect(asked[0]?.symbol).toBe("THYAO")
  })

  // Callers match a response against the uid they asked with.
  test("returns the uid the caller asked with, not the ticker", async () => {
    const { subject } = build()
    const series = await load(subject, "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da")

    expect(series.instrumentUid).toBe("viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da")
  })

  test("charts the underlying by default", async () => {
    const { subject, asked } = build()
    await load(subject, "viop-ftr-index")
    expect(asked[0]?.symbol).toBe("XU030")
  })

  test("charts the contract itself when asked for it", async () => {
    const { subject, asked } = build()
    await load(subject, "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da", "INSTRUMENT")
    expect(asked[0]?.symbol).toBe("F_THYAO0826")
  })

  test("maps the index targets to their own symbols", async () => {
    const { subject, asked } = build()
    await load(subject, "viop-ftr-index", "BIST_100")
    await load(subject, "viop-ftr-index", "BIST_30")
    expect(asked.map((entry) => entry.symbol)).toEqual(["XU100", "XU030"])
  })

  // Index symbols are passed straight through by some callers.
  test("passes an unknown identifier through as a ticker", async () => {
    const { subject, asked } = build()
    await load(subject, "XU100")
    expect(asked[0]?.symbol).toBe("XU100")
  })

  test("falls back to the contract when it has no underlying", async () => {
    const { subject, asked } = build([{ ...INSTRUMENTS[0]!, underlyingSymbol: null }])
    await load(subject, INSTRUMENTS[0]!.uid)
    expect(asked[0]?.symbol).toBe("F_THYAO0826")
  })

  test("reads the instrument list once for repeated loads", async () => {
    const { subject, listCalls } = build()
    await load(subject, "viop-ftr-index")
    await load(subject, "viop-ftr-index")
    await load(subject, "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da")

    expect(listCalls()).toBe(1)
  })

  // Charts and rules can resolve at once on a screen open.
  test("shares one list read across concurrent loads", async () => {
    const { subject, listCalls } = build()
    await Promise.all([
      load(subject, "viop-ftr-index"),
      load(subject, "viop-ftr-5a94d9f0-7a1c-41d5-940a-d325aa5e22da"),
      load(subject, "viop-ftr-index", "INSTRUMENT"),
    ])

    expect(listCalls()).toBe(1)
  })

  test("does not re-read the list for every unknown identifier", async () => {
    const { subject, listCalls } = build()
    await load(subject, "XU100")
    await load(subject, "XU050")
    expect(listCalls()).toBe(1)
  })
})
