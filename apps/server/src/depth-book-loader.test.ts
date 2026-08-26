import { describe, expect, test } from "bun:test"
import type {
  DepthBook,
  DepthBookListener,
  DepthStatus,
  DepthStatusListener,
  DepthStream,
} from "@trbot/market/depth.ts"
import { LiveDepthBookLoader } from "./depth-book-loader.ts"

class FakeDepthStream implements DepthStream {
  private bookListener: DepthBookListener | null = null
  private statusListener: DepthStatusListener | null = null
  startedWith: string | null = null
  stopped = 0

  subscribe(listener: DepthBookListener): void {
    this.bookListener = listener
  }

  onStatusChange(listener: DepthStatusListener): void {
    this.statusListener = listener
    listener("idle")
  }

  start(symbol: string): void {
    this.startedWith = symbol
    this.statusListener?.("connecting")
  }

  stop(): void {
    this.stopped += 1
    this.statusListener?.("idle")
  }

  emit(book: DepthBook): void {
    this.statusListener?.("live")
    this.bookListener?.(book)
  }

  status(status: DepthStatus): void {
    this.statusListener?.(status)
  }
}

class FakeDepthFactory {
  readonly opened: FakeDepthStream[] = []

  open = (): FakeDepthStream => {
    const stream = new FakeDepthStream()
    this.opened.push(stream)
    return stream
  }
}

function book(symbol: string, price: number): DepthBook {
  return {
    symbol,
    bids: [{ price, lots: 10, orderCount: 1 }],
    asks: [{ price: price + 1, lots: 20, orderCount: 2 }],
    buyLots: 10,
    sellLots: 20,
    trades: [],
    marketClosed: false,
  }
}

describe("LiveDepthBookLoader", () => {
  test("returns the complete opening turn and releases its stream", async () => {
    const factory = new FakeDepthFactory()
    let now = 123_456
    const loader = new LiveDepthBookLoader({ openStream: factory.open, now: () => now, settleMs: 0 })
    const pending = loader.loadDepthBookSnapshot(" f_isctr0826 ")
    const stream = factory.opened[0]!

    stream.emit(book("F_ISCTR0826", 35.52))
    now = 123_457
    const complete = book("F_ISCTR0826", 35.53)
    stream.emit(complete)

    await expect(pending).resolves.toEqual({ book: complete, updatedAt: 123_457 })
    expect(stream.startedWith).toBe("F_ISCTR0826")
    expect(stream.stopped).toBe(1)
  })

  test("coalesces simultaneous requests for the same symbol", async () => {
    const factory = new FakeDepthFactory()
    const loader = new LiveDepthBookLoader({ openStream: factory.open, settleMs: 0 })
    const first = loader.loadDepthBookSnapshot("GARAN")
    const second = loader.loadDepthBookSnapshot(" garan ")

    expect(factory.opened).toHaveLength(1)
    factory.opened[0]!.emit(book("GARAN", 130))
    const [left, right] = await Promise.all([first, second])

    expect(left).toEqual(right)
    expect(factory.opened[0]!.stopped).toBe(1)
  })

  test("opens a fresh subscription after every completed request", async () => {
    const factory = new FakeDepthFactory()
    const loader = new LiveDepthBookLoader({ openStream: factory.open, settleMs: 0 })

    const first = loader.loadDepthBookSnapshot("GARAN")
    factory.opened[0]!.emit(book("GARAN", 130))
    await first

    const second = loader.loadDepthBookSnapshot("GARAN")
    factory.opened[1]!.emit(book("GARAN", 131))
    await expect(second).resolves.toMatchObject({ book: { bids: [{ price: 131 }] } })
    expect(factory.opened).toHaveLength(2)
  })

  test("stops immediately when depth is unavailable", async () => {
    const factory = new FakeDepthFactory()
    const loader = new LiveDepthBookLoader({ openStream: factory.open })
    const pending = loader.loadDepthBookSnapshot("GARAN")

    factory.opened[0]!.status("unavailable")

    await expect(pending).rejects.toThrow("Order book is unavailable for GARAN")
    expect(factory.opened[0]!.stopped).toBe(1)
  })

  test("times out and releases a silent stream", async () => {
    const factory = new FakeDepthFactory()
    const loader = new LiveDepthBookLoader({ openStream: factory.open, timeoutMs: 5 })
    const pending = loader.loadDepthBookSnapshot("GARAN")

    await expect(pending).rejects.toThrow("Timed out waiting for an order book for GARAN")
    expect(factory.opened[0]!.stopped).toBe(1)
  })

  test("cancels the stream once its last waiter leaves", async () => {
    const factory = new FakeDepthFactory()
    const loader = new LiveDepthBookLoader({ openStream: factory.open })
    const controller = new AbortController()
    const pending = loader.loadDepthBookSnapshot("GARAN", { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toThrow("Market-data request was cancelled")
    expect(factory.opened[0]!.stopped).toBe(1)
  })
})
