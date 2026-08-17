import { expect, test } from "bun:test"
import type { RenderContext, TerminalCapabilities } from "@opentui/core"
import { chartBitmapSupport } from "./bitmap-renderable.ts"

function fakeContext(capabilities: Partial<TerminalCapabilities> | null): RenderContext {
  return {
    capabilities,
    resolution: { width: 800, height: 600 },
    terminalWidth: 100,
    terminalHeight: 50,
    width: 100,
    height: 50,
  } as unknown as RenderContext
}

test("draws kitty bitmaps directly when the terminal supports them", () => {
  const support = chartBitmapSupport(fakeContext({ kitty_graphics: true, multiplexer: "none" }))
  expect(support).toEqual({ mode: "direct", cellPixel: { width: 8, height: 12 } })
})

test("uses unicode placeholders under tmux when kitty graphics pass through", () => {
  const support = chartBitmapSupport(fakeContext({ kitty_graphics: true, multiplexer: "tmux" }))
  expect(support?.mode).toBe("placeholder")
})

test("falls back to braille under tmux without kitty graphics", () => {
  expect(chartBitmapSupport(fakeContext({ kitty_graphics: false, multiplexer: "tmux" }))).toBeNull()
})

test("falls back to braille without kitty support or resolution", () => {
  expect(chartBitmapSupport(fakeContext({ kitty_graphics: false, multiplexer: "none" }))).toBeNull()
  const noResolution = {
    capabilities: { kitty_graphics: true, multiplexer: "none" },
    resolution: null,
    terminalWidth: 100,
    terminalHeight: 50,
  } as unknown as RenderContext
  expect(chartBitmapSupport(noResolution)).toBeNull()
})

test("keeps the measured cell size when the terminal stops reporting a resolution", () => {
  // A resize clears the renderer's resolution and the re-query may never be
  // answered, e.g. after switching tmux sessions.
  const context = fakeContext({ kitty_graphics: true, multiplexer: "tmux" })
  expect(chartBitmapSupport(context)?.cellPixel).toEqual({ width: 8, height: 12 })

  const resized = context as unknown as { resolution: unknown; terminalWidth: number }
  resized.resolution = null
  resized.terminalWidth = 80

  expect(chartBitmapSupport(context)).toEqual({ mode: "placeholder", cellPixel: { width: 8, height: 12 } })
})
