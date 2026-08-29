import { expect, test } from "bun:test"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  type CandleSeries,
  type CandleSource,
} from "./candle.ts"
import { LevelMonitorFeed } from "./level-monitor-feed.ts"

const NOW = 1_786_000_000_000

function series(): CandleSeries {
  return {
    instrumentUid: "instrument-1",
    range: "INTRADAY",
    interval: "MIN_5",
    candles: [
      { timestamp: NOW - 60_000, open: 400, high: 405, low: 399, close: 404, volume: null },
      { timestamp: NOW, open: 404, high: 406, low: 403, close: 405, volume: null },
    ],
    availableIntervalsByRange: DEFAULT_INTERVALS_BY_RANGE,
    intervalMs: 60_000,
    currency: "TRY",
  }
}

test("tracks quote and candle freshness from one clock", async () => {
  const candles: CandleSource = { loadCandles: async () => series() }
  const feed = new LevelMonitorFeed({ candles, stalePriceMs: 10_000, now: () => NOW })

  const target = {
    symbol: "ASELS",
    instrumentUid: "instrument-1",
    interval: null,
    basis: "TOUCH",
  } as const
  const quote = feed.recordQuote({ symbol: "ASELS", lastPrice: 410, sessionStatus: null, timestamp: NOW + 1_000 })
  expect(quote).toEqual({ price: 410, timestamp: NOW, observedAt: NOW })
  expect(feed.view(target, 420, NOW)).toEqual({
    level: 420,
    lastPrice: 410,
    distancePercent: ((420 - 410) / 410) * 100,
    feed: "live",
  })
  expect(feed.view(target, 420, NOW + 10_001).feed).toBe("stale")

  const closedPrices: number[] = []
  const changed = await feed.refreshCandles(
    [{ instrumentUid: "instrument-1", interval: "MIN_5" }],
    ({ lastClosed }) => {
      if (lastClosed) closedPrices.push(lastClosed.close)
      return false
    },
  )
  expect(changed).toBe(true)
  expect(closedPrices).toEqual([404])
  expect(feed.view({ ...target, interval: "MIN_5", basis: "CLOSE" }, 420, NOW)).toEqual({
    level: 420,
    lastPrice: 404,
    distancePercent: ((420 - 404) / 404) * 100,
    feed: "live",
  })
})

test("reports candle failures but ignores cancellation during destroy", async () => {
  const failure = new Error("feed unavailable")
  const errors: unknown[] = []
  const failing = new LevelMonitorFeed({
    candles: { loadCandles: async () => { throw failure } },
    onError: (error) => errors.push(error),
  })
  expect(await failing.refreshCandles([{ instrumentUid: "instrument-1", interval: "MIN_5" }], () => false))
    .toBe(false)
  expect(errors).toEqual([failure])

  let signal: AbortSignal | undefined
  const pendingSource: CandleSource = {
    loadCandles: (_instrumentUid, _range, _interval, options) => {
      signal = options?.signal
      return new Promise<CandleSeries>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      })
    },
  }
  const feed = new LevelMonitorFeed({ candles: pendingSource, onError: (error) => errors.push(error) })
  const refresh = feed.refreshCandles([{ instrumentUid: "instrument-1", interval: "MIN_5" }], () => false)
  feed.destroy()

  expect(signal?.aborted).toBe(true)
  expect(await refresh).toBe(false)
  expect(errors).toEqual([failure])
})
