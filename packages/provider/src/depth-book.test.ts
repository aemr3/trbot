import { expect, test } from "bun:test"
import { parseDepthUpdate } from "@trbot/api/market.ts"
import { DepthBookAccumulator } from "./depth-book.ts"

// Frames as the provider sends them: an opening snapshot with the full ladder
// and trade tape, then deltas that touch only what moved.
const SNAPSHOT = '{"s":"ASELS","dpt":{"bc":1425521,"sc":2166667,"b":[{"p":389.75,"o":26,"l":38384,"i":0},{"p":389.5,"o":34,"l":29960,"i":1},{"p":389.25,"o":29,"l":27252,"i":2}],"s":[{"p":390,"o":51,"l":28352,"i":0},{"p":390.25,"o":119,"l":45810,"i":1},{"p":390.5,"o":154,"l":51081,"i":2}]},"trd":{"l":3,"mt":"f","t":[{"p":390,"l":111,"d":"b","b":"Gedik Yatırım","s":"PhillipCapital","id":"202608131508353809355"},{"p":390,"l":15,"d":"b","b":"İş Yatırım","s":"PhillipCapital","id":"202608131508343809234"},{"p":389.75,"l":18,"d":"s","b":"İş Yatırım","s":"Ak Yatırım","id":"202608131508293808757"}]}}'
const LEVEL_DELTA = '{"s":"ASELS","dpt":{"bc":1425412,"sc":2166556,"s":[{"p":390,"o":53,"l":28358,"i":0}]}}'
const TRADE_DELTA = '{"s":"ASELS","trd":{"l":3,"mt":"p","t":[{"p":390.25,"l":25,"d":"b","b":"Yapı Kredi Yatırım","s":"Yatırım Finansman","id":"202608131509143814638"}]}}'

function apply(accumulator: DepthBookAccumulator, frame: string) {
  const update = parseDepthUpdate(frame)
  if (!update) throw new Error("frame did not parse")
  return accumulator.apply(update)
}

test("parses the abbreviated order book payload", () => {
  const update = parseDepthUpdate(SNAPSHOT)

  expect(update?.symbol).toBe("ASELS")
  expect(update?.depth).toMatchObject({ buyLots: 1_425_521, sellLots: 2_166_667 })
  expect(update?.depth?.bids[0]).toEqual({ index: 0, level: { price: 389.75, lots: 38_384, orderCount: 26 } })
  expect(update?.trades?.replace).toBeTrue()
  expect(update?.trades?.items[2]).toMatchObject({ side: "SELL", buyer: "İş Yatırım", seller: "Ak Yatırım" })
  expect(parseDepthUpdate("not json")).toBeNull()
  expect(parseDepthUpdate('{"dpt":{}}')).toBeNull()
})

test("builds the opening book from the snapshot frame", () => {
  const book = apply(new DepthBookAccumulator(), SNAPSHOT)

  expect(book.symbol).toBe("ASELS")
  expect(book.bids.map((level) => level.price)).toEqual([389.75, 389.5, 389.25])
  expect(book.asks.map((level) => level.price)).toEqual([390, 390.25, 390.5])
  expect(book.buyLots).toBe(1_425_521)
  expect(book.trades).toHaveLength(3)
})

test("merges a level delta into its ladder slot and leaves the rest standing", () => {
  const accumulator = new DepthBookAccumulator()
  apply(accumulator, SNAPSHOT)

  const book = apply(accumulator, LEVEL_DELTA)

  expect(book.asks[0]).toEqual({ price: 390, lots: 28_358, orderCount: 53 })
  expect(book.asks.map((level) => level.price)).toEqual([390, 390.25, 390.5])
  // A frame carrying only asks must not clear the bids.
  expect(book.bids).toHaveLength(3)
  expect(book.sellLots).toBe(2_166_556)
  expect(book.trades).toHaveLength(3)
})

test("prepends a partial trade and drops the oldest beyond the tape length", () => {
  const accumulator = new DepthBookAccumulator()
  apply(accumulator, SNAPSHOT)

  const book = apply(accumulator, TRADE_DELTA)

  expect(book.trades).toHaveLength(3)
  expect(book.trades[0]).toMatchObject({ id: "202608131509143814638", price: 390.25, side: "BUY" })
  expect(book.trades.map((trade) => trade.id)).not.toContain("202608131508293808757")
})

test("ignores a trade already on the tape and orders a late one by its id", () => {
  const accumulator = new DepthBookAccumulator()
  apply(accumulator, SNAPSHOT)
  const late = TRADE_DELTA.replace("202608131509143814638", "202608131508303808821")

  const repeated = apply(accumulator, '{"s":"ASELS","trd":{"l":3,"mt":"p","t":[{"p":390,"l":111,"d":"b","b":"Gedik Yatırım","s":"PhillipCapital","id":"202608131508353809355"}]}}')
  expect(repeated.trades.map((trade) => trade.id)).toEqual([
    "202608131508353809355",
    "202608131508343809234",
    "202608131508293808757",
  ])

  const book = apply(accumulator, late)
  expect(book.trades.map((trade) => trade.id)).toEqual([
    "202608131508353809355",
    "202608131508343809234",
    "202608131508303808821",
  ])
})

test("starts a fresh book when the symbol changes", () => {
  const accumulator = new DepthBookAccumulator()
  apply(accumulator, SNAPSHOT)

  const book = apply(accumulator, LEVEL_DELTA.replace(/ASELS/, "THYAO"))

  expect(book.symbol).toBe("THYAO")
  expect(book.bids).toHaveLength(0)
  expect(book.asks).toHaveLength(1)
  expect(book.trades).toHaveLength(0)
})
