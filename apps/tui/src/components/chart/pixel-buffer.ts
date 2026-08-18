// Braille pixel canvas: every terminal cell holds a 2x4 dot grid, so a plot of
// W x H cells behaves like a (W*2) x (H*4) framebuffer with per-cell color.
import { RGBA, type TextChunk } from "@opentui/core"

interface Pixel {
  color: string
  layer: number
}

export interface PixelBuffer {
  width: number // dot columns (2 per terminal column)
  height: number // dot rows (4 per terminal row)
  pixels: (Pixel | null)[][] // [y][x]
}

// Higher layers win inside a cell, e.g. candles overdraw grid dots.
export const LAYER_GRID = 0
export const LAYER_FILL = 1
export const LAYER_DATA = 2

const BRAILLE_BASE = 0x2800
const BRAILLE_DOT: number[][] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

function makeChunk(text: string, fgColor?: string): TextChunk {
  const chunk: TextChunk = { __isChunk: true, text }
  if (fgColor) chunk.fg = RGBA.fromHex(fgColor)
  return chunk
}

export function createPixelBuffer(width: number, height: number): PixelBuffer {
  const bufferWidth = Number.isFinite(width) ? Math.max(Math.floor(width), 0) : 0
  const bufferHeight = Number.isFinite(height) ? Math.max(Math.floor(height), 0) : 0
  const pixels: (Pixel | null)[][] = []
  for (let y = 0; y < bufferHeight; y++) {
    pixels.push(Array.from({ length: bufferWidth }, () => null))
  }
  return { width: bufferWidth, height: bufferHeight, pixels }
}

export function setPixel(buf: PixelBuffer, x: number, y: number, color: string, layer: number): void {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px >= 0 && px < buf.width && py >= 0 && py < buf.height) {
    const row = buf.pixels[py]
    if (!row) return
    const existing = row[px]
    if (!existing || layer >= existing.layer) {
      row[px] = { color, layer }
    }
  }
}

export function drawLine(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  layer: number = LAYER_DATA,
): void {
  const startX = Math.round(x0)
  const startY = Math.round(y0)
  const endX = Math.round(x1)
  const endY = Math.round(y1)
  if (![startX, startY, endX, endY].every(Number.isFinite)) return
  const dx = Math.abs(endX - startX)
  const dy = Math.abs(endY - startY)
  const sx = startX < endX ? 1 : -1
  const sy = startY < endY ? 1 : -1
  let err = dx - dy
  let x = startX
  let y = startY

  while (true) {
    setPixel(buf, x, y, color, layer)
    if (x === endX && y === endY) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

function fillColumn(buf: PixelBuffer, x: number, y0: number, y1: number, color: string, layer: number): void {
  const start = Math.min(y0, y1)
  const end = Math.max(y0, y1)
  for (let y = start; y <= end; y++) {
    setPixel(buf, x, y, color, layer)
  }
}

export function fillRect(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  layer: number,
): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    fillColumn(buf, x, y0, y1, color, layer)
  }
}

/** Sparse horizontal guides: one dot every sixth column on otherwise empty rows. */
export function drawGridLines(buf: PixelBuffer, yPositions: number[], color: string): void {
  for (const rawY of yPositions) {
    const y = Math.round(rawY)
    if (y < 0 || y >= buf.height) continue
    const row = buf.pixels[y]
    if (!row) continue
    for (let x = 0; x < buf.width; x++) {
      if (x % 6 === 0 && !row[x]) {
        setPixel(buf, x, y, color, LAYER_GRID)
      }
    }
  }
}

/** Dashed horizontal marker (two dots on, two off) for the current price. */
export function drawGuideLine(buf: PixelBuffer, y: number, color: string): void {
  const py = Math.round(y)
  if (py < 0 || py >= buf.height) return
  for (let x = 0; x < buf.width; x++) {
    if (x % 4 < 2) {
      setPixel(buf, x, py, color, LAYER_FILL)
    }
  }
}

/**
 * Dashed vertical marker (two dots on, two off) through the picked candle. It
 * is drawn under the data layer, so the candle it marks stays on top of it.
 */
export function drawMarkerColumn(buf: PixelBuffer, x: number, color: string): void {
  const px = Math.round(x)
  if (px < 0 || px >= buf.width) return
  for (let y = 0; y < buf.height; y++) {
    if (y % 4 < 2) {
      setPixel(buf, px, y, color, LAYER_FILL)
    }
  }
}

/**
 * Collapses the dot grid into one row of styled chunks per terminal row. Each
 * cell shows the dot pattern of its topmost layer, colored by that layer's
 * dominant color; equal adjacent cells are merged into a single chunk.
 */
export function bufferToBrailleLines(buf: PixelBuffer): TextChunk[][] {
  const lines: TextChunk[][] = []
  const termCols = Math.ceil(buf.width / 2)
  const termRows = Math.ceil(buf.height / 4)

  for (let row = 0; row < termRows; row++) {
    const chunks: TextChunk[] = []
    let runChar = ""
    let runFg: string | undefined
    let runLen = 0

    const flushRun = () => {
      if (runLen > 0) {
        chunks.push(makeChunk(runChar.repeat(runLen), runFg))
        runLen = 0
      }
    }

    for (let col = 0; col < termCols; col++) {
      let topLayer = -1
      const dotsByLayer = new Map<number, number>()
      const colorByLayer = new Map<number, Map<string, number>>()

      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = col * 2 + dx
          const py = row * 4 + dy
          if (px >= buf.width || py >= buf.height) continue
          const pixel = buf.pixels[py]?.[px] ?? null
          if (!pixel) continue
          const bit = BRAILLE_DOT[dy]![dx]!
          dotsByLayer.set(pixel.layer, (dotsByLayer.get(pixel.layer) || 0) | bit)
          if (!colorByLayer.has(pixel.layer)) colorByLayer.set(pixel.layer, new Map())
          const counts = colorByLayer.get(pixel.layer)!
          counts.set(pixel.color, (counts.get(pixel.color) || 0) + 1)
          if (pixel.layer > topLayer) {
            topLayer = pixel.layer
          }
        }
      }

      let char: string
      let cellFg: string | undefined
      if (topLayer < 0) {
        char = " "
        cellFg = undefined
      } else {
        const pattern = dotsByLayer.get(topLayer) || 0
        char = String.fromCharCode(BRAILLE_BASE + pattern)

        const topCounts = colorByLayer.get(topLayer) ?? new Map<string, number>()
        let topColor = ""
        let bestCount = 0
        for (const [color, count] of topCounts) {
          if (count > bestCount) {
            bestCount = count
            topColor = color
          }
        }
        cellFg = topColor
      }

      if (char === runChar && cellFg === runFg) {
        runLen++
      } else {
        flushRun()
        runChar = char
        runFg = cellFg
        runLen = 1
      }
    }

    flushRun()
    lines.push(chunks)
  }

  return lines
}
