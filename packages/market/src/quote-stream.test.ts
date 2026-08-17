import { expect, test } from "bun:test"
import { parseFuturePriceUpdate } from "@trbot/api/market.ts"
import type { SseFrame } from "@trbot/api/transport.ts"
import { ApiQuoteStream, type QuoteUpdate } from "./quote-stream.ts"

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function priceFrame(symbol: string, price: number, event = "PriceUpdate"): SseFrame {
  return { event, data: JSON.stringify({ s: symbol, p: price, a: price + 0.02, b: price - 0.02, ts: 1 }) }
}

type Script = SseFrame[] | { error: unknown }

class FakeStreamClient {
  calls = 0
  lastQuery: Record<string, string> | undefined
  constructor(private readonly scripts: Script[]) {}

  async *stream(options: { query?: Record<string, string> }): AsyncGenerator<SseFrame> {
    this.lastQuery = options.query
    const script = this.scripts[this.calls] ?? []
    this.calls++
    if (!Array.isArray(script)) throw script.error
    for (const frame of script) yield frame
  }
}

test("parseFuturePriceUpdate maps the single-letter payload", () => {
  const update = parseFuturePriceUpdate('{"s":"F_AKBNK0825","p":68.68,"a":68.7,"b":68.66,"ss":"OPEN","ts":1712000000000}')
  expect(update).toEqual({
    symbol: "F_AKBNK0825",
    lastPrice: 68.68,
    ask: 68.7,
    bid: 68.66,
    sessionStatus: "OPEN",
    timestamp: 1712000000000,
  })
})

test("parseFuturePriceUpdate rejects payloads without a symbol or with bad JSON", () => {
  expect(parseFuturePriceUpdate('{"p":1}')).toBeNull()
  expect(parseFuturePriceUpdate("not json")).toBeNull()
})

test("emits parsed updates and subscribes with the comma-joined symbols", async () => {
  const client = new FakeStreamClient([[priceFrame("F_AKBNK0825", 68.68)]])
  const updates: QuoteUpdate[] = []
  const stream = new ApiQuoteStream(client as never, { reconnectDelaysMs: [0] })
  stream.subscribe((update) => {
    updates.push(update)
    stream.stop()
  })

  stream.start(["F_AKBNK0825", "F_THYAO0826"])
  await waitFor(() => updates.length >= 1)

  expect(client.lastQuery).toEqual({ symbol: "F_AKBNK0825,F_THYAO0826" })
  expect(updates[0]).toMatchObject({ symbol: "F_AKBNK0825", lastPrice: 68.68, ask: 68.7 })
  expect(updates[0]?.bid).toBeCloseTo(68.66)
})

test("skips frames whose event name is not PriceUpdate", async () => {
  const client = new FakeStreamClient([[priceFrame("F_AKBNK0825", 1, "Heartbeat"), priceFrame("F_AKBNK0825", 2)]])
  const updates: QuoteUpdate[] = []
  const stream = new ApiQuoteStream(client as never, { reconnectDelaysMs: [0] })
  stream.subscribe((update) => {
    updates.push(update)
    stream.stop()
  })

  stream.start(["F_AKBNK0825"])
  await waitFor(() => updates.length >= 1)

  expect(updates).toHaveLength(1)
  expect(updates[0]?.lastPrice).toBe(2)
})

test("reconnects after the stream ends and resubscribes", async () => {
  const client = new FakeStreamClient([[priceFrame("F_AKBNK0825", 10)], [priceFrame("F_AKBNK0825", 11)]])
  const updates: QuoteUpdate[] = []
  const stream = new ApiQuoteStream(client as never, { reconnectDelaysMs: [0] })
  stream.subscribe((update) => {
    updates.push(update)
    if (updates.length >= 2) stream.stop()
  })

  stream.start(["F_AKBNK0825"])
  await waitFor(() => updates.length >= 2)

  expect(client.calls).toBeGreaterThanOrEqual(2)
  expect(updates.map((u) => u.lastPrice)).toEqual([10, 11])
})

test("reports connected on the first tick and disconnected when the stream ends", async () => {
  const client = new FakeStreamClient([[priceFrame("F_AKBNK0825", 10)]])
  const states: boolean[] = []
  const stream = new ApiQuoteStream(client as never, { reconnectDelaysMs: [0] })
  stream.onConnectionChange((connected) => {
    states.push(connected)
    if (states.length >= 2) stream.stop()
  })

  stream.start(["F_AKBNK0825"])
  await waitFor(() => states.length >= 2)

  expect(states.slice(0, 2)).toEqual([true, false])
})

test("reports connection errors and keeps retrying", async () => {
  const client = new FakeStreamClient([{ error: new Error("boom") }, [priceFrame("F_AKBNK0825", 5)]])
  const errors: unknown[] = []
  const updates: QuoteUpdate[] = []
  const stream = new ApiQuoteStream(client as never, {
    reconnectDelaysMs: [0],
    onError: (error) => errors.push(error),
  })
  stream.subscribe((update) => {
    updates.push(update)
    stream.stop()
  })

  stream.start(["F_AKBNK0825"])
  await waitFor(() => updates.length >= 1)

  expect(errors).toHaveLength(1)
  expect(updates[0]?.lastPrice).toBe(5)
})

test("resubscribes when the symbol set changes and ignores an identical one", async () => {
  // The stream stays open until the symbols change, so one script is enough.
  const client = new FakeStreamClient([[priceFrame("F_AKBNK0825", 68.68)]])
  const updates: QuoteUpdate[] = []
  const stream = new ApiQuoteStream(client as never, { reconnectDelaysMs: [10_000] })
  stream.subscribe((update) => updates.push(update))

  stream.start(["F_AKBNK0825"])
  await waitFor(() => updates.length >= 1)
  expect(client.lastQuery?.symbol).toBe("F_AKBNK0825")
  const callsAfterFirst = client.calls

  // The same set is the same subscription, whatever order it arrives in.
  stream.start(["F_AKBNK0825"])
  expect(client.calls).toBe(callsAfterFirst)

  // A position outside the watchlist joins: the stream reopens with both.
  stream.start(["F_THYAO0825", "F_AKBNK0825"])
  await waitFor(() => client.lastQuery?.symbol === "F_AKBNK0825,F_THYAO0825")
  stream.stop()
})
