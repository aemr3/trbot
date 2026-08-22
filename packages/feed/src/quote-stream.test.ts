import { describe, expect, test } from "bun:test"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import { FeedQuoteStream } from "./quote-stream.ts"
import type { FieldUpdate, SocketListener, SocketSubscriber } from "./socket.ts"

/** Stands in for the shared socket, exposing what was subscribed and letting tests push frames. */
class FakeMarketSocket implements SocketSubscriber {
  readonly subscriptions: { topics: string[]; listener: SocketListener }[] = []
  readonly released: string[][] = []

  subscribe(topics: string[], listener: SocketListener): () => void {
    const entry = { topics, listener }
    this.subscriptions.push(entry)
    return () => this.released.push(topics)
  }

  get current(): SocketListener {
    const last = this.subscriptions[this.subscriptions.length - 1]
    if (!last) throw new Error("nothing subscribed")
    return last.listener
  }

  push(updates: FieldUpdate[]): void {
    this.current.onFields?.(updates)
  }
}

function buildWithSession(session: string, now: number) {
  const socket = new FakeMarketSocket()
  const stream = new FeedQuoteStream(socket, { now: () => now, sessionFor: () => session })
  const updates: QuoteUpdate[] = []
  stream.subscribe((update) => updates.push(update))
  return { socket, stream, updates }
}

function build() {
  const socket = new FakeMarketSocket()
  const stream = new FeedQuoteStream(socket, { now: () => 1_700_000_000_000 })
  const updates: QuoteUpdate[] = []
  stream.subscribe((update) => updates.push(update))
  return { socket, stream, updates }
}

describe("FeedQuoteStream", () => {
  test("subscribes to the quote fields for every symbol", () => {
    const { socket, stream } = build()
    stream.start(["GARAN"])

    expect(socket.subscriptions[0]?.topics).toEqual([
      "GARAN/C",
      "GARAN/P",
      "GARAN/A",
      "GARAN/B",
      "GARAN/d",
      "GARAN/T",
    ])
  })

  /**
   * The feed pushes one field at a time. Publishing only the field that moved
   * would blank the price a rule is watching, so prior values are held.
   */
  test("merges single-field deltas into a complete quote", () => {
    const { socket, stream, updates } = build()
    stream.start(["GARAN"])

    socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    expect(updates[0]).toEqual({
      symbol: "GARAN",
      lastPrice: 129.9,
      ask: null,
      bid: null,
      sessionStatus: null,
      timestamp: 1_700_000_000_000,
    })

    socket.push([{ symbol: "GARAN", field: "B", value: 129.8 }])
    expect(updates[1]?.lastPrice).toBe(129.9)
    expect(updates[1]?.bid).toBe(129.8)
  })

  test("keeps each symbol's state separate", () => {
    const { socket, stream, updates } = build()
    stream.start(["GARAN", "THYAO"])

    socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    socket.push([{ symbol: "THYAO", field: "C", value: 310.5 }])
    socket.push([{ symbol: "GARAN", field: "A", value: 130.0 }])

    const last = updates[updates.length - 1]
    expect(last?.symbol).toBe("GARAN")
    expect(last?.lastPrice).toBe(129.9)
    expect(last?.ask).toBe(130.0)
    expect(updates.find((update) => update.symbol === "THYAO")?.lastPrice).toBe(310.5)
  })

  test("uses the feed's clock when it sends one", () => {
    const { socket, stream, updates } = build()
    stream.start(["GARAN"])

    socket.push([
      { symbol: "GARAN", field: "T", value: 1_787_324_940 },
      { symbol: "GARAN", field: "C", value: 129.9 },
    ])
    expect(updates[0]?.timestamp).toBe(1_787_324_940_000)
  })

  test("treats a cleared price as null rather than zero", () => {
    const { socket, stream, updates } = build()
    stream.start(["GARAN"])

    socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    socket.push([{ symbol: "GARAN", field: "C", value: null }])
    expect(updates[1]?.lastPrice).toBeNull()
  })

  /**
   * The feed's session code is undocumented beyond two values — the vendor's own
   * client maps only 2 and 13 — so open and closed are read from the exchange's
   * published hours instead of from the code.
   */
  test("reports open and closed from the exchange's trading hours", () => {
    const open = buildWithSession("0955-1810", Date.parse("2026-08-21T10:00:00Z"))
    open.stream.start(["GARAN"])
    open.socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    expect(open.updates[0]?.sessionStatus).toBe("OPEN")

    const closed = buildWithSession("0955-1810", Date.parse("2026-08-21T20:00:00Z"))
    closed.stream.start(["GARAN"])
    closed.socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    expect(closed.updates[0]?.sessionStatus).toBe("CLOSED")
  })

  // 13 is `DEVRE_KESICI`, the one halt the clock cannot show.
  test("reports a circuit breaker over the clock", () => {
    const { socket, stream, updates } = buildWithSession("0955-1810", Date.parse("2026-08-21T10:00:00Z"))
    stream.start(["GARAN"])

    socket.push([{ symbol: "GARAN", field: "d", value: 13 }])
    expect(updates[0]?.sessionStatus).toBe("CIRCUIT_BREAKER")
  })

  /** 26 and 38 both occur and neither is documented, so neither is acted on. */
  test("ignores session codes nothing defines a meaning for", () => {
    const { socket, stream, updates } = buildWithSession("0955-1810", Date.parse("2026-08-21T10:00:00Z"))
    stream.start(["GARAN"])

    socket.push([{ symbol: "GARAN", field: "d", value: 26 }])
    expect(updates[0]?.sessionStatus).toBe("OPEN")
    socket.push([{ symbol: "GARAN", field: "d", value: 38 }])
    expect(updates[1]?.sessionStatus).toBe("OPEN")
  })

  test("reports no status while the trading hours are unknown", () => {
    const { socket, stream, updates } = build()
    stream.start(["GARAN"])

    socket.push([{ symbol: "GARAN", field: "C", value: 129.9 }])
    expect(updates[0]?.sessionStatus).toBeNull()
  })

  test("resubscribes when the symbol set changes", () => {
    const { socket, stream } = build()
    stream.start(["GARAN"])
    stream.start(["GARAN", "THYAO"])

    expect(socket.subscriptions).toHaveLength(2)
    expect(socket.released).toHaveLength(1)
  })

  // Holdings are re-read often, and the set usually has not moved.
  test("ignores a repeated identical symbol set", () => {
    const { socket, stream } = build()
    stream.start(["GARAN", "THYAO"])
    stream.start(["THYAO", "GARAN"])

    expect(socket.subscriptions).toHaveLength(1)
  })

  test("releases its topics on stop", () => {
    const { socket, stream } = build()
    stream.start(["GARAN"])
    stream.stop()

    expect(socket.released).toEqual([[
      "GARAN/C",
      "GARAN/P",
      "GARAN/A",
      "GARAN/B",
      "GARAN/d",
      "GARAN/T",
    ]])
  })

  test("forwards connection state to its listeners", () => {
    const { socket, stream } = build()
    const states: boolean[] = []
    stream.onConnectionChange((connected) => states.push(connected))
    stream.start(["GARAN"])

    socket.current.onConnectionChange?.(true)
    socket.current.onConnectionChange?.(false)
    expect(states).toEqual([true, false])
  })

  test("reports a lost license to the application", () => {
    let taken = 0
    const socket = new FakeMarketSocket()
    const stream = new FeedQuoteStream(socket, { onLicenseTaken: () => taken++ })
    stream.start(["GARAN"])

    socket.current.onLicenseTaken?.()
    expect(taken).toBe(1)
  })
})
