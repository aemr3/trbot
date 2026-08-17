import { expect, test } from "bun:test"
import { StreamHttpError, type SseFrame } from "@trbot/api/transport.ts"
import { ApiDepthStream } from "./api-depth-stream.ts"
import type { DepthBook, DepthStatus } from "./depth.ts"

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function snapshot(symbol: string): string {
  return JSON.stringify({
    s: symbol,
    dpt: { bc: 100, sc: 300, b: [{ p: 10, o: 2, l: 40, i: 0 }], s: [{ p: 11, o: 3, l: 60, i: 0 }] },
  })
}

class FakeStreamClient {
  calls: { path: string; query?: Record<string, string>; signal?: AbortSignal }[] = []

  constructor(private readonly failWith?: Error) {}

  async *stream(options: { path: string; query?: Record<string, string>; signal?: AbortSignal }): AsyncGenerator<SseFrame> {
    this.calls.push(options)
    if (this.failWith) throw this.failWith
    yield { event: null, data: snapshot(options.query?.symbol ?? "") }
  }
}

test("streams the requested book and follows a new symbol", async () => {
  const client = new FakeStreamClient()
  const books: DepthBook[] = []
  const stream = new ApiDepthStream(client as never, { reconnectDelaysMs: [1000] })
  stream.subscribe((book) => books.push(book))

  stream.start("asels")
  await waitFor(() => books.some((book) => book.symbol === "ASELS"))
  stream.start("THYAO")
  await waitFor(() => books.some((book) => book.symbol === "THYAO"))
  stream.stop()

  expect(client.calls[0]).toEqual({
    path: "/reactive-market-depth-api/v2/depth/stream",
    query: { symbol: "ASELS", type: "DETAIL" },
    signal: expect.anything(),
  })
  const book = books.find((entry) => entry.symbol === "ASELS")
  expect(book?.bids[0]).toEqual({ price: 10, lots: 40, orderCount: 2 })
  expect(book?.buyLots).toBe(100)
})

test("reports the book as unavailable and stops retrying when the symbol has none", async () => {
  const client = new FakeStreamClient(new StreamHttpError(404))
  const statuses: DepthStatus[] = []
  const stream = new ApiDepthStream(client as never, { reconnectDelaysMs: [1] })
  stream.onStatusChange((status) => statuses.push(status))

  stream.start("F_ASELS0826")
  await waitFor(() => statuses.includes("unavailable"))
  await new Promise((resolve) => setTimeout(resolve, 30))

  expect(statuses).toEqual(["connecting", "unavailable"])
  // A 404 is a property of the symbol, so the stream must not reconnect.
  expect(client.calls).toHaveLength(1)
})

test("keeps retrying a transient stream failure", async () => {
  const client = new FakeStreamClient(new StreamHttpError(503))
  const errors: unknown[] = []
  const stream = new ApiDepthStream(client as never, {
    reconnectDelaysMs: [1],
    onError: (error) => errors.push(error),
  })

  stream.start("ASELS")
  await waitFor(() => client.calls.length >= 2)
  stream.stop()

  expect(errors.length).toBeGreaterThan(0)
})
