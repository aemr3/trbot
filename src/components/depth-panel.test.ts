import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { DepthBook } from "../market/depth.ts"
import { DepthPanel } from "./depth-panel.ts"

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
    { id: "2", price: 390, lots: 111, side: "BUY", buyer: "Gedik Yatırım", seller: "PhillipCapital" },
    { id: "1", price: 389.75, lots: 18, side: "SELL", buyer: "İş Yatırım", seller: "Ak Yatırım" },
  ],
  marketClosed: false,
  maintenance: false,
  infoMessage: null,
}

// The watchlist screen owns the panel's box, so the test sizes it the same way.
async function mountPanel(height = 30) {
  const harness = await createTestRenderer({ width: 48, height })
  const panel = new DepthPanel(harness.renderer)
  panel.root.width = 48
  panel.root.height = height
  harness.renderer.root.add(panel.root)
  return { ...harness, panel }
}

test("renders the ratio, both ladder sides, and the trade tape", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", underlyingSymbol: "ASELS" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Depth  ASELS  ● live")
  expect(frame).toContain("Buy 39,7%")
  expect(frame).toContain("60,3% Sell")
  expect(frame).toContain("1.425.521")
  expect(frame).toContain("Bid│Ask")
  expect(frame).toContain("38.384  389,75│390,00      28.352")
  expect(frame).toContain("Trades")
  expect(frame).toContain("390,00      111 Gedik ← PhillipCapital")

  renderer.destroy()
})

test("reports a locked panel when market depth is not part of the subscription", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.selectInstrument({ displayName: "ASELS", underlyingSymbol: "ASELS" })

  await renderOnce()
  expect(captureCharFrame()).toContain("Checking market depth access")

  panel.setEntitled(false)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("paid feature")
  expect(frame).not.toContain("389,75")

  renderer.destroy()
})

test("explains a contract whose underlying has no book", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)

  panel.selectInstrument({ displayName: "XU030", underlyingSymbol: null })
  await renderOnce()
  expect(captureCharFrame()).toContain("XU030 has no underlying stock.")

  panel.selectInstrument({ displayName: "ASELS", underlyingSymbol: "ASELS" })
  panel.setStatus("unavailable")
  await renderOnce()
  expect(captureCharFrame()).toContain("No depth book for ASELS.")

  renderer.destroy()
})

test("ignores a book for a symbol the panel is no longer showing", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel()
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "THYAO", underlyingSymbol: "THYAO" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()

  expect(captureCharFrame()).toContain("Loading depth…")
  renderer.destroy()
})

test("trims the trade tape to the rows the panel has left", async () => {
  const { renderer, renderOnce, captureCharFrame, panel } = await mountPanel(20)
  panel.setEntitled(true)
  panel.selectInstrument({ displayName: "ASELS", underlyingSymbol: "ASELS" })
  panel.setStatus("live")

  panel.showBook(book)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Trades")
  expect(frame).not.toContain("389,75       18 İş ← Ak")

  renderer.destroy()
})
