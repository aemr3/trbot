// True-pixel rasterizer for the portfolio's performance bars. Block glyphs
// quantize a bar to half a row, which turns a small day into either nothing or
// the same stub as a middling one; at pixel resolution every bar is drawn at
// the height it actually is.
import type { ChartBitmap } from "./raster.ts"

export interface PerformanceBar {
  value: number
  label: string
}

export interface BarBitmapOptions {
  bars: PerformanceBar[]
  width: number
  height: number
  upColor: string
  downColor: string
  zeroColor: string
}

// Share of a bar's slot taken by the bar itself; the rest is the gap that keeps
// neighbours apart.
const BAR_FILL = 0.72
// The zero line is drawn at least this thick so it survives at any height.
const ZERO_LINE_PIXELS = 1
// A bar this tall is drawn even when its value rounds to nothing, so a flat day
// still reads as a day rather than a hole in the series.
const MIN_BAR_PIXELS = 2

/**
 * Draws the bars around a zero line, gains rising and losses hanging. Both
 * halves share one scale, taken from the largest magnitude in the set, so a
 * small loss beside a large gain reads as small.
 */
export function renderBarBitmap(options: BarBitmapOptions): ChartBitmap {
  const width = Math.max(1, Math.floor(options.width))
  const height = Math.max(1, Math.floor(options.height))
  const pixels = new Uint8Array(width * height * 4)
  const bars = options.bars
  if (bars.length === 0) return { width, height, pixels }

  const peak = Math.max(...bars.map((bar) => Math.abs(bar.value)))
  // The zero line sits in the middle: both directions get the same room, so a
  // gain and a loss of the same size are drawn the same size.
  const zeroY = Math.round(height / 2)
  const halfHeight = Math.max(1, zeroY - 1)
  const slot = width / bars.length
  const barWidth = Math.max(1, Math.round(slot * BAR_FILL))

  const up = parseHex(options.upColor)
  const down = parseHex(options.downColor)
  const zero = parseHex(options.zeroColor)

  // The line goes down first so a bar sitting on it keeps its full height; the
  // line is what shows in the gaps between bars.
  fillRect(pixels, width, height, 0, zeroY - ZERO_LINE_PIXELS, width, zeroY, zero)

  bars.forEach((bar, index) => {
    const left = Math.round(index * slot + (slot - barWidth) / 2)
    const extent = peak > 0 ? Math.round((Math.abs(bar.value) / peak) * halfHeight) : 0
    const length = Math.max(MIN_BAR_PIXELS, extent)
    if (bar.value >= 0) {
      fillRect(pixels, width, height, left, zeroY - length, left + barWidth, zeroY, up)
    } else {
      fillRect(pixels, width, height, left, zeroY, left + barWidth, zeroY + length, down)
    }
  })

  return { width, height, pixels }
}

interface Rgba {
  r: number
  g: number
  b: number
}

function fillRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: Rgba,
): void {
  const firstColumn = Math.max(0, Math.round(left))
  const lastColumn = Math.min(width - 1, Math.round(right) - 1)
  const firstRow = Math.max(0, Math.round(top))
  const lastRow = Math.min(height - 1, Math.round(bottom) - 1)
  for (let y = firstRow; y <= lastRow; y++) {
    for (let x = firstColumn; x <= lastColumn; x++) {
      const index = (y * width + x) * 4
      pixels[index] = color.r
      pixels[index + 1] = color.g
      pixels[index + 2] = color.b
      pixels[index + 3] = 255
    }
  }
}

function parseHex(hex: string): Rgba {
  const normalized = hex.replace("#", "")
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}
