import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { CredentialsRequiredError } from "../api/index.ts"
import type { ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsSource } from "../market/news.ts"
import type { QuoteStream, QuoteUpdate, QuoteUpdateListener } from "../market/quote-stream.ts"
import { WatchlistScreen } from "./watchlist.ts"

class FakeQuoteStream implements QuoteStream {
  private listener: QuoteUpdateListener | null = null
  private connectionListener: ((connected: boolean) => void) | null = null
  startedSymbols: string[] | null = null
  stopped = false

  subscribe(listener: QuoteUpdateListener): void {
    this.listener = listener
  }
  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListener = listener
  }
  start(symbols: string[]): void {
    this.startedSymbols = symbols
  }
  stop(): void {
    this.stopped = true
  }
  emit(update: QuoteUpdate): void {
    this.listener?.(update)
  }
  emitConnection(connected: boolean): void {
    this.connectionListener?.(connected)
  }
}

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
    return [{ uid: "n1", tag: "08 Ağu", headline: "BIST 30 güne yükselişle başladı", body: "Hacim arttı.", publishedAt: null, url: null, attachments: [] }]
  },
  async getArticle(uid) {
    return { uid, tag: "08 Ağu", headline: "BIST 30 güne yükselişle başladı", body: "Full body text.", publishedAt: null, url: null, attachments: [] }
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

test("shows a snapshot indicator until the stream reports live ticks", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })
  const quotes = new FakeQuoteStream()

  const screen = new WatchlistScreen(renderer, { instruments, news, quotes })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("snapshot"))
  expect(captureCharFrame()).toContain("○ snapshot")

  quotes.emitConnection(true)
  await waitForFrame((f) => f.includes("live"))
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("● live")
  expect(frame).not.toContain("snapshot")

  screen.destroy()
  renderer.destroy()
})

test("applies live price ticks in place and subscribes with instrument symbols", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 30,
  })
  const quotes = new FakeQuoteStream()

  const screen = new WatchlistScreen(renderer, { instruments, news, quotes })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("THYAO"))
  expect(quotes.startedSymbols).toContain("F_THYAO0826")

  quotes.emit({ symbol: "F_THYAO0826", lastPrice: 320, sessionStatus: null, timestamp: 1 })
  await waitForFrame((f) => f.includes("320,00"))
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("320,00")
  expect(frame).toContain("+1.34%") // derived from the seeded reference close

  screen.destroy()
  expect(quotes.stopped).toBe(true)
  renderer.destroy()
})

test("notifies onSessionExpired when the session cannot be restored", async () => {
  const { renderer, waitFor } = await createTestRenderer({ width: 80, height: 20 })
  let expired = false
  const failing: ViopInstrumentSource = {
    async listInstruments() {
      throw new CredentialsRequiredError()
    },
  }

  const screen = new WatchlistScreen(renderer, {
    instruments: failing,
    news,
    onSessionExpired: () => {
      expired = true
    },
  })
  renderer.root.add(screen.root)
  screen.mount()

  await waitFor(() => expired)
  expect(expired).toBe(true)

  screen.destroy()
  renderer.destroy()
})

test("opens a news article on double-click and returns on a second double-click", async () => {
  const { renderer, mockMouse, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 20,
  })

  const screen = new WatchlistScreen(renderer, { instruments, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("BIST 30 güne"))
  const lines = captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("BIST 30 güne"))
  const x = lines[y]!.indexOf("BIST")

  await mockMouse.doubleClick(x, y)
  await waitForFrame((f) => f.includes("Full body text."))

  await mockMouse.doubleClick(x, 2) // double-click the reader to go back
  await waitForFrame((f) => !f.includes("Full body text.") && f.includes("BIST 30 güne"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Full body text.")

  screen.destroy()
  renderer.destroy()
})

test("opens a news article with its full body on Enter and returns on Backspace", async () => {
  const { renderer, mockInput, renderOnce, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 20,
  })

  const screen = new WatchlistScreen(renderer, { instruments, news })
  renderer.root.add(screen.root)
  screen.mount()

  await waitForFrame((f) => f.includes("BIST 30 güne"))

  mockInput.pressTab() // move focus to the news panel
  mockInput.pressEnter() // open the selected article
  await waitForFrame((f) => f.includes("Full body text."))

  mockInput.pressBackspace() // back to the headline list
  await waitForFrame((f) => !f.includes("Full body text.") && f.includes("BIST 30 güne"))
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Full body text.")

  screen.destroy()
  renderer.destroy()
})
