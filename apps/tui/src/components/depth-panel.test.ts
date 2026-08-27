import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { DepthBook } from "@trbot/market/depth.ts"
import { DepthPanel, type DepthPanelOptions } from "./depth-panel.ts"
import type { ParsedKey } from "@opentui/core"

const book: DepthBook = {
  symbol: "ASELS",
  bids: [
    { price: 389.75, lots: 38_384, orderCount: 26 },
    { price: 389.5, lots: 29_960, orderCount: 34 },
  ],
  asks: [
    { price: 390, lots: 28_352, orderCount: 51 },
    { price: 390.25, lots: 45_810, orderCount: 119 },
  ],
  buyLots: 1_425_521,
  sellLots: 2_166_667,
  trades: [
    {
      id: "2",
      price: 390,
      lots: 111,
      timestamp: Date.parse("2026-08-21T10:15:30Z"),
      side: "BUY",
      buyer: "Gedik Yatırım",
      seller: "PhillipCapital",
    },
    {
      id: "1",
      price: 389.75,
      lots: 18,
      timestamp: Date.parse("2026-08-21T10:15:29Z"),
      side: "SELL",
      buyer: "İş Yatırım",
      seller: "Ak Yatırım",
    },
  ],
  marketClosed: false,
}

// The watchlist screen owns the panel's box, so the test sizes it the same way.
async function mountPanel(height = 30, options: DepthPanelOptions = {}) {
  const harness = await createTestRenderer({ width: 48, height })
  const panel = new DepthPanel(harness.renderer, options)
  panel.root.width = 48
  panel.root.height = height
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
}

/**
 * The background painted behind `text`, as the terminal actually renders it.
 * The selected switch is marked by a fill, so this is what proves the marking
 * rather than any state the panel could be asked for.
 */
type CapturedLines = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>["lines"]

function backgroundBehind(lines: CapturedLines, text: string): string | null {
  for (const line of lines) {
    for (const span of line.spans) {
      if (!span.text.includes(text)) continue
      const bg = span.bg.buffer
      return `${bg[0]},${bg[1]},${bg[2]}`
    }
  }
  return null
}

function key(sequence: string): ParsedKey {
  // SAFETY: the panel reads only `sequence` and `name` off the event.
  return { name: sequence, sequence } as ParsedKey
}

test("renders the ratio, both ladder sides, and the trade tape", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Depth  ● live")
  // The switches sit beside the title, as the chart's do.
  expect(frame).toContain("Stock")
  expect(frame).toContain("Futures")
  expect(frame).toContain("Buy 39,7%")
  expect(frame).toContain("60,3% Sell")
  expect(frame).toContain("1.425.521")
  expect(frame).toContain("Bid│Ask")
  expect(frame).toContain("38.384  389,75│390,00      28.352")
  expect(frame).toContain("Trades")
  const tradeLine = frame.split("\n").find((line) => line.includes("111")) ?? ""
  expect(tradeLine).toContain("390,00      111 Gedik")
  expect(tradeLine.trimEnd()).toEndWith("13:15:30")

  renderer.destroy()
})

test("shows trade time without an empty broker column for futures", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(30, { initialTarget: "INSTRUMENT" })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.setStatus("live")
  panel.showBook({
    ...book,
    symbol: "F_ASELS0826",
    trades: book.trades.map((trade) => ({ ...trade, buyer: null, seller: null })),
  })
  await renderOnce()

  const tradeLine = captureCharFrame().split("\n").find((line) => line.includes("111")) ?? ""
  expect(tradeLine).not.toContain("←")
  expect(tradeLine).not.toContain("—")
  expect(tradeLine.trimEnd()).toEndWith("13:15:30")

  renderer.destroy()
})

test("reports a locked panel when market depth is not part of the subscription", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })

  await renderOnce()
  expect(captureCharFrame()).toContain("Checking market depth access")

  panel.setEntitled(false)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("paid feature")
  expect(frame).not.toContain("389,75")

  renderer.destroy()
})

test("falls back to the futures book when the underlying is unavailable", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)

  panel.selectInstrument({ displayName: "XU030", symbol: "F_XU0300826", underlyingSymbol: null })
  await renderOnce()
  expect(panel.activeSymbol()).toBe("F_XU0300826")
  expect(captureCharFrame()).toContain("Futures")
  expect(captureCharFrame()).not.toContain("Stock")

  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.setStatus("unavailable")
  await renderOnce()
  expect(captureCharFrame()).toContain("No depth book for ASELS.")

  renderer.destroy()
})

test("ignores a book for a symbol the panel is no longer showing", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "THYAO", symbol: "F_THYAO0826", underlyingSymbol: "THYAO" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()

  expect(captureCharFrame()).toContain("Loading depth…")
  renderer.destroy()
})

test("trims the trade tape to the rows the panel has left", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(20)
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Trades")
  expect(frame).not.toContain("389,75       18 İş ← Ak")

  renderer.destroy()
})

/**
 * Both books exist now: the market data feed serves one for the stock and one
 * for the contract written on it. The brokerage feed carried only the
 * underlying's, so the panel had nothing to switch between.
 */
test("switches between the stock's book and the contract's", async () => {
  const targets: string[] = []
  const { panel } = await mountPanel(30, { onTargetChange: (target) => targets.push(target) })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })

  expect(panel.activeSymbol()).toBe("ASELS")
  expect(panel.handleKey(key("f"))).toBe(true)
  expect(panel.activeSymbol()).toBe("F_ASELS0826")
  expect(panel.handleKey(key("f"))).toBe(true)
  expect(panel.activeSymbol()).toBe("ASELS")
  expect(targets).toEqual(["INSTRUMENT", "UNDERLYING"])
})

test("opens on the book the trader last looked at", async () => {
  const { panel } = await mountPanel(30, { initialTarget: "INSTRUMENT" })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })

  expect(panel.activeSymbol()).toBe("F_ASELS0826")
})

test("marks the contract as the shown book when restored to it", async () => {
  const { renderOnce, captureSpans, panel } = await mountPanel(30, { initialTarget: "INSTRUMENT" })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  await renderOnce()

  // The header no longer names the instrument, so the lit switch is what says
  // which book is on screen.
  const lines = captureSpans().lines
  expect(backgroundBehind(lines, "Futures")).not.toBe(backgroundBehind(lines, "Stock"))
  expect(panel.activeSymbol()).toBe("F_ASELS0826")
})

// A book for the symbol it just left would otherwise paint over the new one.
test("drops the previous book when the target changes", async () => {
  const { renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.showBook(book)
  await renderOnce()
  expect(captureCharFrame()).toContain("389,75")

  panel.handleKey(key("f"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("389,75")
})

test("leaves other keys to the screen behind it", async () => {
  const { panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })

  expect(panel.handleKey(key("x"))).toBe(false)
  expect(panel.activeSymbol()).toBe("ASELS")
})

/**
 * The chart's asset switches are clickable buttons, so these have to be too —
 * a switch that only answers a key nobody knows about reads as broken.
 */
test("switches book when the button is clicked", async () => {
  const targets: string[] = []
  const { renderer, renderOnce, captureCharFrame, mockMouse, panel } = await mountPanel(30, {
    onTargetChange: (target) => targets.push(target),
  })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  await renderOnce()

  const header = captureCharFrame().split("\n")[0] ?? ""
  const column = header.indexOf("Futures")
  expect(column).toBeGreaterThan(0)

  await mockMouse.click(column, 0)
  expect(panel.activeSymbol()).toBe("F_ASELS0826")
  expect(targets).toEqual(["INSTRUMENT"])
  expect(renderer.getSelection()).toBeNull()
})

test("marks the selected book the way the chart marks its own", async () => {
  const { renderOnce, captureSpans, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  await renderOnce()

  const unselected = backgroundBehind(captureSpans().lines, "Futures")
  expect(backgroundBehind(captureSpans().lines, "Stock")).not.toBe(unselected)

  panel.handleKey(key("f"))
  await renderOnce()
  // The fill follows the selection, so the two switches swap backgrounds.
  expect(backgroundBehind(captureSpans().lines, "Futures")).not.toBe(unselected)
  expect(backgroundBehind(captureSpans().lines, "Stock")).toBe(unselected)
})

/**
 * The failure this exists to prevent: the switch resubscribes and the server
 * answers, and every one of those books is thrown away because the panel is still
 * comparing against the underlying. The panel sits on "Loading depth…" forever.
 */
test("shows the contract's own book when the contract is the shown side", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(30, { initialTarget: "INSTRUMENT" })
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", symbol: "F_ASELS0826", underlyingSymbol: "ASELS" })
  panel.setStatus("live")

  panel.showBook({ ...book, symbol: "F_ASELS0826" })
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("389,75")
  expect(frame).not.toContain("Loading depth")

  // The underlying's book belongs to the side that is not on screen.
  panel.showBook({ ...book, symbol: "ASELS", bids: [{ price: 1.23, lots: 1, orderCount: 1 }] })
  await renderOnce()
  expect(captureCharFrame()).not.toContain("1,23")

  renderer.destroy()
})

/**
 * Outside session hours the exchange clears every level, so the book is empty
 * rather than missing. The panel draws the empty ladder — the shape the trader
 * knows — and says why in the header, instead of replacing the whole book with a
 * sentence.
 */
test("draws the empty ladder for a closed market", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(30)
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "SAHOL", symbol: "F_SAHOL0826", underlyingSymbol: "SAHOL" })
  panel.setStatus("live")

  panel.showBook({
    symbol: "SAHOL",
    bids: [],
    asks: [],
    buyLots: null,
    sellLots: null,
    trades: [],
    marketClosed: true,
  })
  await renderOnce()
  // The layout settles a frame after the header's text changes width.
  await renderOnce()
  const frame = captureCharFrame()

  // The scaffold: both ladder headings, the spread rule, and the tape heading.
  expect(frame).toContain("Bid")
  expect(frame).toContain("Ask")
  expect(frame).toContain("│")
  expect(frame).toContain("Trades")
  // The connection is live; the market is not, and the header is where that goes.
  expect(frame).toContain("○ closed")
  expect(frame).not.toContain("● live")
  expect(frame).not.toContain("is closed.")
  // A per-session tape after the close has nothing still to come.
  expect(frame).toContain("No trades.")

  renderer.destroy()
})
