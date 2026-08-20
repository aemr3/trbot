import { expect, test } from "bun:test"
import type { SseFrame } from "@trbot/api/transport.ts"
import type { EquityQuoteUpdate } from "@trbot/market/equity-quote-stream.ts"
import { ApiEquityQuoteStream, parseEquityQuoteUpdates } from "./equity-quote-stream.ts"

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class FakeStreamClient {
  calls: { path: string; query?: Record<string, string> }[] = []

  async *stream(options: { path: string; query?: Record<string, string>; signal?: AbortSignal }): AsyncGenerator<SseFrame> {
    this.calls.push(options)
    const symbol = options.query?.TR ?? ""
    yield {
      event: "Ticker",
      data: JSON.stringify([{ c: "TR", cr: "TRY", p: symbol === "THYAO" ? 315 : 170, s: symbol, ss: "OPEN", t: 1_786_176_000 }]),
    }
  }
}

test("parses the abbreviated Turkish equity ticker payload", () => {
  expect(parseEquityQuoteUpdates('[{"c":"TR","cr":"TRY","p":170.5,"s":"TUPRS","ss":"OPEN","t":1786176000}]')).toEqual([
    { symbol: "TUPRS", lastPrice: 170.5, sessionStatus: "OPEN", timestamp: 1_786_176_000_000 },
  ])
  expect(parseEquityQuoteUpdates("not json")).toEqual([])
})

test("subscribes to the active underlying stock and replaces it on selection changes", async () => {
  const client = new FakeStreamClient()
  const updates: EquityQuoteUpdate[] = []
  const stream = new ApiEquityQuoteStream(client, { reconnectDelaysMs: [1000] })
  stream.subscribe((update) => updates.push(update))

  stream.start("tuprs")
  await waitFor(() => updates.some((update) => update.symbol === "TUPRS"))
  stream.start("THYAO")
  await waitFor(() => updates.some((update) => update.symbol === "THYAO"))
  stream.stop()

  expect(client.calls[0]).toMatchObject({
    path: "/reactive-market-api/v1/instruments/trade-price/stream",
    query: { TR: "TUPRS", overnightEnabled: "true" },
  })
  expect(client.calls.some((call) => call.query?.TR === "THYAO")).toBeTrue()
})
