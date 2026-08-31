import { describe, expect, test } from "bun:test"
import type { DepthBook, DepthStatus } from "@trbot/market/depth.ts"
import { FeedDepthStream } from "./depth-stream.ts"
import type { SocketListener, SocketSubscriber, SocketSubscriptionOptions } from "./socket.ts"
import type { FeedRecord } from "./value.ts"

class FakeMarketSocket implements SocketSubscriber {
  readonly subscribed: string[][] = []
  readonly released: string[][] = []
  readonly refreshes: Array<boolean | undefined> = []
  listener: SocketListener = {}

  subscribe(
    topics: string[],
    listener: SocketListener,
    options?: SocketSubscriptionOptions,
  ): () => void {
    this.subscribed.push(topics)
    this.refreshes.push(options?.refresh)
    this.listener = listener
    return () => this.released.push(topics)
  }

  /** A level frame exactly as observed on the wire. */
  level(payload: FeedRecord, symbol = "F_XU0300826"): void {
    this.listener.onDepth?.({ symbol, payload })
  }

  trade(payload: FeedRecord, symbol = "F_XU0300826"): void {
    this.listener.onTrade?.({ symbol, payload })
  }
}

function build() {
  const socket = new FakeMarketSocket()
  const stream = new FeedDepthStream(socket)
  const books: DepthBook[] = []
  const statuses: DepthStatus[] = []
  stream.subscribe((book) => books.push(book))
  stream.onStatusChange((status) => statuses.push(status))
  stream.start("F_XU0300826")
  return { socket, stream, books, statuses }
}

function latest(books: DepthBook[]): DepthBook {
  const book = books[books.length - 1]
  if (!book) throw new Error("no book was published")
  return book
}

describe("FeedDepthStream", () => {
  test("reports a closed market from the symbol's trading hours", async () => {
    const socket = new FakeMarketSocket()
    const books: DepthBook[] = []
    // 21:00 Istanbul on a Friday, well after the equity close.
    const stream = new FeedDepthStream(socket, {
      loadSession: async () => "0955-1810",
      now: () => Date.parse("2026-08-21T18:00:00Z"),
    })
    stream.subscribe((book) => books.push(book))
    stream.start("SOKM")
    await Bun.sleep(5)
    socket.level({ l: 0, obs: "B", p: null, c: null, s: null }, "SOKM")

    expect(latest(books).marketClosed).toBe(true)
  })

  test("does not call a trading market closed", async () => {
    const socket = new FakeMarketSocket()
    const books: DepthBook[] = []
    // 13:00 Istanbul on a Friday, mid-session.
    const stream = new FeedDepthStream(socket, {
      loadSession: async () => "0955-1810",
      now: () => Date.parse("2026-08-21T10:00:00Z"),
    })
    stream.subscribe((book) => books.push(book))
    stream.start("SOKM")
    await Bun.sleep(5)
    socket.level({ l: 0, obs: "B", p: 59, c: 2, s: 10 }, "SOKM")

    expect(latest(books).marketClosed).toBe(false)
    expect(latest(books).bids).toEqual([{ price: 59, lots: 10, orderCount: 2 }])
  })

  test("subscribes to the book, side totals, and live trades", () => {
    const { socket } = build()
    expect(socket.subscribed[0]).toEqual([
      "F_XU0300826/ob-10",
      "F_XU0300826/BV",
      "F_XU0300826/AV",
      "F_XU0300826/TRU",
    ])
  })

  test("appends a live trade from the subscribed trade topic", () => {
    const { socket, books } = build()

    socket.trade({ p: 16822, s: 7, a: "B", bb: null, sb: null, i: 40613120, t: 1787325000 })

    expect(latest(books).trades).toEqual([{
      id: "40613120",
      price: 16822,
      lots: 7,
      timestamp: 1_787_325_000_000,
      side: "BUY",
      buyer: null,
      seller: null,
    }])
  })

  test("can request a new opening snapshot for already-retained topics", () => {
    const socket = new FakeMarketSocket()
    const stream = new FeedDepthStream(socket, { requestSnapshot: true })

    stream.start("F_XU0300826")

    expect(socket.refreshes).toEqual([true])
  })

  // `obs` is "B" or "S"; `s` is the size in lots and `c` the order count.
  test("decodes a bid level from the wire shape", () => {
    const { socket, books } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })

    expect(latest(books).bids).toEqual([{ price: 16821, lots: 5, orderCount: 1 }])
    expect(latest(books).asks).toEqual([])
  })

  test("decodes an ask level from the wire shape", () => {
    const { socket, books } = build()
    socket.level({ l: 0, obs: "S", p: 16823, c: 6, s: 6 })

    expect(latest(books).asks).toEqual([{ price: 16823, lots: 6, orderCount: 6 }])
    expect(latest(books).bids).toEqual([])
  })

  test("keeps both sides of the book apart", () => {
    const { socket, books } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    socket.level({ l: 1, obs: "B", p: 16820, c: 3, s: 38 })
    socket.level({ l: 0, obs: "S", p: 16822, c: 1, s: 1 })
    socket.level({ l: 1, obs: "S", p: 16823, c: 6, s: 6 })

    const book = latest(books)
    expect(book.bids.map((level) => level.price)).toEqual([16821, 16820])
    expect(book.asks.map((level) => level.price)).toEqual([16822, 16823])
  })

  // Index 0 has to straddle the spread: best bid highest, best ask lowest.
  test("orders each side best price first regardless of arrival order", () => {
    const { socket, books } = build()
    socket.level({ l: 2, obs: "B", p: 16817, c: 3, s: 3 })
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    socket.level({ l: 3, obs: "S", p: 16826, c: 9, s: 112 })
    socket.level({ l: 0, obs: "S", p: 16822, c: 1, s: 1 })

    const book = latest(books)
    expect(book.bids[0]?.price).toBe(16821)
    expect(book.asks[0]?.price).toBe(16822)
  })

  test("replaces a level when the same index prints again", () => {
    const { socket, books } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    socket.level({ l: 0, obs: "B", p: 16821, c: 2, s: 9 })

    expect(latest(books).bids).toEqual([{ price: 16821, lots: 9, orderCount: 2 }])
  })

  test("drops a level once it holds nothing", () => {
    const { socket, books } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    socket.level({ l: 1, obs: "B", p: 16820, c: 3, s: 38 })
    socket.level({ l: 1, obs: "B", p: 16820, c: 0, s: 0 })

    expect(latest(books).bids).toEqual([{ price: 16821, lots: 5, orderCount: 1 }])
  })

  test("reads the side totals behind the buy/sell ratio", () => {
    const { socket, books } = build()
    socket.listener.onFields?.([
      { symbol: "F_XU0300826", field: "BV", value: 1200 },
      { symbol: "F_XU0300826", field: "AV", value: 900 },
    ])

    expect(latest(books).buyLots).toBe(1200)
    expect(latest(books).sellLots).toBe(900)
  })

  test("goes live once a level arrives", () => {
    const { socket, statuses } = build()
    expect(statuses).toEqual(["idle", "connecting"])

    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    expect(statuses[statuses.length - 1]).toBe("live")
  })

  /**
   * Outside session hours the exchange sends a full book with every level null.
   * That is an empty book, not a missing one — reading it as "no depth book for
   * this symbol" is what made a closed market look like an unsupported one.
   */
  test("treats a null-priced level as an empty level, not a missing book", () => {
    const { socket, books, statuses } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    socket.level({ l: 0, obs: "B", p: null, c: null, s: null })

    expect(statuses[statuses.length - 1]).toBe("live")
    expect(latest(books).bids).toEqual([])
  })

  test("stays live through a whole book being cleared", () => {
    const { socket, statuses } = build()
    for (const side of ["B", "S"] as const) {
      for (let level = 0; level < 10; level++) socket.level({ l: level, obs: side, p: null, c: null, s: null })
    }

    expect(statuses).not.toContain("unavailable")
    expect(statuses[statuses.length - 1]).toBe("live")
  })

  // Without a side and level index there is nothing to place in the book.
  test("ignores a frame that carries no level", () => {
    const { socket, books, statuses } = build()
    socket.level({ nonsense: 1 })

    expect(books).toEqual([])
    expect(statuses[statuses.length - 1]).toBe("connecting")
  })

  test("ignores frames for a symbol it is not watching", () => {
    const { stream, socket, books } = build()
    socket.listener.onDepth?.({ symbol: "GARAN", payload: { l: 0, obs: "B", p: 129.9, c: 1, s: 5 } })

    expect(books).toEqual([])
    stream.stop()
  })

  test("releases its topics and clears the book on stop", () => {
    const { socket, stream, statuses } = build()
    socket.level({ l: 0, obs: "B", p: 16821, c: 1, s: 5 })
    stream.stop()

    expect(socket.released).toHaveLength(1)
    expect(statuses[statuses.length - 1]).toBe("idle")
  })

  test("marks depth unavailable when the license is lost", () => {
    const { socket, statuses } = build()
    socket.listener.onLicenseTaken?.()
    expect(statuses[statuses.length - 1]).toBe("unavailable")
  })
})
