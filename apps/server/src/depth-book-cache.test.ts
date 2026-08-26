import { describe, expect, test } from "bun:test"
import type { DepthBook } from "@trbot/market/depth.ts"
import { LiveDepthBookCache } from "./depth-book-cache.ts"

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

describe("LiveDepthBookCache", () => {
  test("returns the latest observed book with its server receipt time", () => {
    let now = 123_456
    const cache = new LiveDepthBookCache(() => now)
    const first = book("F_ISCTR0826", 35.52)
    cache.accept(first)

    expect(cache.getDepthBookSnapshot(" f_isctr0826 ")).toEqual({
      book: first,
      updatedAt: 123_456,
    })

    now = 234_567
    const latest = book("F_ISCTR0826", 35.53)
    cache.accept(latest)
    expect(cache.getDepthBookSnapshot("F_ISCTR0826")).toEqual({
      book: latest,
      updatedAt: 234_567,
    })
  })

  test("returns null for a symbol the server has not delivered", () => {
    const cache = new LiveDepthBookCache()

    expect(cache.getDepthBookSnapshot("F_YKBNK0826")).toBeNull()
  })
})
