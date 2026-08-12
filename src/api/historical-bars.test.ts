import { expect, test } from "bun:test"
import { HttpHistoricalBarSource, type HistoricalBarRequest } from "./historical-bars.ts"

test("loads five-minute OHLCV history with Bun's default user agent", async () => {
  const requested: { url?: URL; headers?: Headers } = {}
  const request: HistoricalBarRequest = async (input, init) => {
    requested.url = new URL(input instanceof Request ? input.url : input)
    requested.headers = new Headers(init?.headers)
    return Response.json({
      s: "ok",
      t: [1_786_393_200, 1_786_393_500],
      o: [312.5, 313],
      h: [313.5, 314],
      l: [312, 312.75],
      c: [313, 313.75],
      v: [100, 150],
    })
  }

  const bars = await new HttpHistoricalBarSource(request)
    .loadFiveMinuteBars("F_THYAO0826", 1_786_393_200_000, 1_786_394_000_000)

  expect(requested.url?.searchParams.get("symbol")).toBe("F_THYAO0826")
  expect(requested.url?.searchParams.get("resolution")).toBe("5")
  expect(requested.url?.searchParams.get("currencyCode")).toBe("TRY")
  expect(requested.headers?.get("accept")).toBe("application/json")
  expect(requested.headers?.has("user-agent")).toBe(false)
  expect(bars).toEqual([
    { timestamp: 1_786_393_200_000, open: 312.5, high: 313.5, low: 312, close: 313, volume: 100 },
    { timestamp: 1_786_393_500_000, open: 313, high: 314, low: 312.75, close: 313.75, volume: 150 },
  ])
})

test("rejects misaligned historical OHLCV responses", async () => {
  const request: HistoricalBarRequest = async () => Response.json({
    s: "ok",
    t: [1, 2],
    o: [1],
    h: [2, 3],
    l: [0, 1],
    c: [1, 2],
    v: [10, 20],
  })

  expect(new HttpHistoricalBarSource(request).loadFiveMinuteBars("F_TEST0826", 0, 10_000))
    .rejects.toThrow("misaligned OHLCV arrays")
})

test("skips isolated rows whose OHLC values are null", async () => {
  const request: HistoricalBarRequest = async () => Response.json({
    s: "ok",
    t: [1_786_393_200, 1_786_393_500, 1_786_393_800],
    o: [312.5, null, 313],
    h: [313.5, null, 314],
    l: [312, null, 312.75],
    c: [313, null, 313.75],
    v: [100, 136_120_000, 150],
  })

  const bars = await new HttpHistoricalBarSource(request)
    .loadFiveMinuteBars("F_THYAO0826", 1_786_393_200_000, 1_786_394_000_000)

  expect(bars.map((bar) => bar.timestamp)).toEqual([1_786_393_200_000, 1_786_393_800_000])
  expect(bars.map((bar) => bar.volume)).toEqual([100, 150])
})

test("returns an empty series when historical data is unavailable", async () => {
  const request: HistoricalBarRequest = async () => Response.json({ s: "no_data" })
  expect(await new HttpHistoricalBarSource(request).loadFiveMinuteBars("F_TEST0826", 0, 10_000)).toEqual([])
})
