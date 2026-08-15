import { expect, test } from "bun:test"
import type { Candle } from "../../market/candle.ts"
import { CHART_PALETTE } from "./palette.ts"
import { renderCandleBitmap } from "./raster.ts"

const candle = (open: number, close: number, volume: number | null = null): Candle => ({
  timestamp: 0,
  open,
  high: Math.max(open, close) + 1,
  low: Math.min(open, close) - 1,
  close,
  volume,
})

function hasColor(pixels: Uint8Array, hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] === r && pixels[index + 1] === g && pixels[index + 2] === b && pixels[index + 3]! > 0) {
      return true
    }
  }
  return false
}

test("paints rising and falling bodies in palette colors", () => {
  const bitmap = renderCandleBitmap({
    candles: [candle(100, 110), candle(110, 100)],
    pixelWidth: 64,
    pixelHeight: 64,
    volumePixelHeight: 0,
    min: 95,
    max: 115,
    gridYs: [],
    guideY: null,
    guideColor: CHART_PALETTE.guideUp,
    palette: CHART_PALETTE,
  })

  expect(bitmap.width).toBe(64)
  expect(bitmap.height).toBe(64)
  expect(hasColor(bitmap.pixels, CHART_PALETTE.candleUp)).toBe(true)
  expect(hasColor(bitmap.pixels, CHART_PALETTE.candleDown)).toBe(true)
})

test("reserves the bottom slice for volume bars", () => {
  const bitmap = renderCandleBitmap({
    candles: [candle(100, 110, 500)],
    pixelWidth: 32,
    pixelHeight: 48,
    volumePixelHeight: 16,
    min: 95,
    max: 115,
    gridYs: [],
    guideY: null,
    guideColor: CHART_PALETTE.guideUp,
    palette: CHART_PALETTE,
  })

  const bottom = bitmap.pixels.subarray(32 * 32 * 4)
  expect(hasColor(bottom, CHART_PALETTE.volumeUp)).toBe(true)
})

test("draws the guide line across the full width", () => {
  const bitmap = renderCandleBitmap({
    candles: [candle(100, 110)],
    pixelWidth: 40,
    pixelHeight: 40,
    volumePixelHeight: 0,
    min: 95,
    max: 115,
    gridYs: [],
    guideY: 20,
    guideColor: CHART_PALETTE.guideUp,
    palette: CHART_PALETTE,
  })

  const alphaAt = (x: number, y: number) => bitmap.pixels[(y * bitmap.width + x) * 4 + 3]!
  expect(alphaAt(0, 20)).toBeGreaterThan(0)
  expect(alphaAt(bitmap.width - 1, 20)).toBeGreaterThan(0)
})
