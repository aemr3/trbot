import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsSource } from "../market/news.ts"
import { WatchlistScreen } from "./watchlist.ts"

const instruments: ViopInstrumentSource = {
  async listInstruments() {
    return [
      { uid: "u1", symbol: "F_XU0300826", displayName: "XU030", underlyingSymbol: "XU030", lastPrice: 15910, changePercent: 0.4, currency: "TRY" },
      { uid: "u2", symbol: "F_THYAO0826", displayName: "THYAO", underlyingSymbol: "THYAO", lastPrice: 312.45, changePercent: -1.05, currency: "TRY" },
    ]
  },
}

const news: NewsSource = {
  async listNews() {
    return [{ uid: "n1", instrumentSymbol: "XU030", tag: "Endeks", headline: "BIST 30 güne yükselişle başladı", body: "Hacim arttı.", publishedAt: null }]
  },
}

test("renders the VIOP, chart, and news panels with instrument data", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })

  const screen = new WatchlistScreen(renderer, { instruments, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((frame) => frame.includes("XU030"))
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("VIOP")
  expect(frame).toContain("Chart")
  expect(frame).toContain("News")
  expect(frame).toContain("XU030")

  screen.destroy()
  renderer.destroy()
})
