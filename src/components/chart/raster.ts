// True-pixel candle chart rasterizer for terminals that support the kitty
// graphics protocol: anti-aliased strokes and alpha-blended bodies drawn into
// a raw RGBA bitmap.
import type { Candle } from "../../market/candle.ts"
import type { ChartPalette } from "./palette.ts"
import { candleSlots, type CandleSlots, type IndicatorPolyline } from "./geometry.ts"

export interface ChartBitmap {
  width: number
  height: number
  pixels: Uint8Array // straight-alpha RGBA8, row-major
}

interface RgbaColor {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function smoothstep(edge0: number, edge1: number, value: number): number {
  const range = edge1 - edge0
  if (range === 0) return value < edge0 ? 0 : 1
  const t = clamp((value - edge0) / range, 0, 1)
  return t * t * (3 - 2 * t)
}

function parseHex(hex: string, alpha = 1): RgbaColor {
  const normalized = hex.replace("#", "")
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
    a: Math.round(clamp(alpha, 0, 1) * 255),
  }
}

function blendPixel(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RgbaColor,
  opacity = 1,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return

  const alpha = clamp((color.a / 255) * opacity, 0, 1)
  if (alpha <= 0) return

  const index = (y * width + x) * 4
  const dstAlpha = data[index + 3]! / 255
  const outAlpha = alpha + dstAlpha * (1 - alpha)
  if (outAlpha <= 0) return

  const dstFactor = dstAlpha * (1 - alpha)
  data[index] = Math.round((color.r * alpha + data[index]! * dstFactor) / outAlpha)
  data[index + 1] = Math.round((color.g * alpha + data[index + 1]! * dstFactor) / outAlpha)
  data[index + 2] = Math.round((color.b * alpha + data[index + 2]! * dstFactor) / outAlpha)
  data[index + 3] = Math.round(outAlpha * 255)
}

/** Anti-aliased stroke: coverage falls off smoothly around the segment. */
function drawLine(
  data: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RgbaColor,
  thickness: number,
): void {
  const half = thickness / 2
  const minX = Math.floor(Math.min(x0, x1) - half - 1)
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1)
  const minY = Math.floor(Math.min(y0, y1) - half - 1)
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1)
  const dx = x1 - x0
  const dy = y1 - y0
  const segmentLengthSq = dx * dx + dy * dy || 1

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5
      const cy = py + 0.5
      const projection = clamp(((cx - x0) * dx + (cy - y0) * dy) / segmentLengthSq, 0, 1)
      const nearestX = x0 + dx * projection
      const nearestY = y0 + dy * projection
      const distance = Math.hypot(cx - nearestX, cy - nearestY)
      const coverage = 1 - smoothstep(half, half + 1.1, distance)
      if (coverage > 0) {
        blendPixel(data, width, height, px, py, color, coverage)
      }
    }
  }
}

/**
 * Fills the half-open rect `[left, right) x [top, bottom)`, snapping each edge
 * to the nearest pixel boundary. A stroke centered on a coordinate lands on the
 * same boundary a rect edge does, which is what keeps the price guide flush
 * with the close edge of the candle it tracks. Always paints at least one pixel.
 */
function fillRect(
  data: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: RgbaColor,
  opacity = 1,
): void {
  const firstColumn = Math.round(left)
  const firstRow = Math.round(top)
  const lastColumn = Math.max(Math.round(right) - 1, firstColumn)
  const lastRow = Math.max(Math.round(bottom) - 1, firstRow)
  for (let y = Math.max(firstRow, 0); y <= Math.min(lastRow, height - 1); y++) {
    for (let x = Math.max(firstColumn, 0); x <= Math.min(lastColumn, width - 1); x++) {
      blendPixel(data, width, height, x, y, color, opacity)
    }
  }
}

function projectX(index: number, count: number, left: number, right: number): number {
  if (count <= 1) return (left + right) / 2
  return lerp(left, right, index / (count - 1))
}

function projectY(value: number, min: number, max: number, top: number, bottom: number): number {
  const range = max - min || 1
  return lerp(bottom, top, (value - min) / range)
}

function getBodyWidth(count: number, width: number): number {
  const spacing = width / Math.max(count, 1)
  return clamp(spacing * 0.45, 2, Math.max(spacing - 1, 2))
}

/** Center pixel column of a candle, inset so the widest body stays in bounds. */
export function getCandlePixelX(index: number, count: number, pixelWidth: number): number {
  const horizontalPad = Math.ceil(getBodyWidth(count, pixelWidth) / 2)
  const plotLeft = horizontalPad
  const plotRight = Math.max(pixelWidth - 1 - horizontalPad, plotLeft)
  return projectX(index, count, plotLeft, plotRight)
}

function drawWickOutsideBody(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  highY: number,
  lowY: number,
  bodyTop: number,
  bodyBottom: number,
  color: RgbaColor,
): void {
  if (highY < bodyTop) {
    drawLine(data, width, height, x, highY, x, bodyTop, color, 1.2)
  }
  if (bodyBottom < lowY) {
    drawLine(data, width, height, x, bodyBottom, x, lowY, color, 1.2)
  }
}

function drawCandles(
  data: Uint8Array,
  width: number,
  height: number,
  candles: Candle[],
  top: number,
  bottom: number,
  palette: ChartPalette,
  min: number,
  max: number,
  slots: CandleSlots,
): void {
  const bodyWidth = getBodyWidth(slots.count, width)

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const x = getCandlePixelX(slots.offset + index, slots.count, width)
    const highY = projectY(candle.high, min, max, top, bottom)
    const lowY = projectY(candle.low, min, max, top, bottom)
    const openY = projectY(candle.open, min, max, top, bottom)
    const closeY = projectY(candle.close, min, max, top, bottom)
    const isUp = candle.close >= candle.open

    const wickColor = parseHex(isUp ? palette.wickUp : palette.wickDown, 0.92)
    const bodyColor = parseHex(isUp ? palette.candleUp : palette.candleDown, 1)

    const bodyTop = Math.min(openY, closeY)
    const bodyBottom = Math.max(openY, closeY)
    if (Math.abs(bodyBottom - bodyTop) < 1.25) {
      // Doji: full wick plus a thin horizontal body stroke. The stroke sits on
      // the close, snapped to a pixel boundary, so the price guide overlays it.
      const closeEdge = Math.round(closeY)
      drawLine(data, width, height, x, highY, x, lowY, wickColor, 1.2)
      drawLine(data, width, height, x - bodyWidth / 2, closeEdge, x + bodyWidth / 2, closeEdge, bodyColor, 1.5)
    } else {
      drawWickOutsideBody(data, width, height, x, highY, lowY, bodyTop, bodyBottom, wickColor)
      fillRect(data, width, height, x - bodyWidth / 2, bodyTop, x + bodyWidth / 2, bodyBottom, bodyColor, 1)
    }
  }
}

function drawVolume(
  data: Uint8Array,
  width: number,
  height: number,
  candles: Candle[],
  top: number,
  bottom: number,
  palette: ChartPalette,
  slots: CandleSlots,
): void {
  if (bottom < top) return

  const maxVolume = Math.max(...candles.map((candle) => candle.volume ?? 0), 1)
  const spacing = width / Math.max(slots.count, 1)
  const barWidth = clamp(spacing * 0.72, 1, Math.max(spacing, 1))

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const heightRatio = (candle.volume ?? 0) / maxVolume
    if (heightRatio <= 0) continue
    const x = projectX(slots.offset + index, slots.count, 0, width - 1)
    const barTop = lerp(bottom, top, heightRatio)
    const color = parseHex(candle.close >= candle.open ? palette.volumeUp : palette.volumeDown, 0.6)
    // `bottom` is the last pixel row of the pane, so the rect ends one past it.
    fillRect(data, width, height, x - barWidth / 2, barTop, x + barWidth / 2, bottom + 1, color, 0.8)
  }
}

/** One overlay across the price pane; a gap in the values breaks the line. */
function drawPolyline(
  data: Uint8Array,
  width: number,
  plotBottom: number,
  line: IndicatorPolyline,
  min: number,
  max: number,
  slots: CandleSlots,
): void {
  const color = parseHex(line.color, 0.95)
  let previousX: number | null = null
  let previousY = 0
  for (let index = 0; index < line.values.length; index++) {
    const value = line.values[index]
    if (value === null || value === undefined) {
      previousX = null
      continue
    }
    const x = getCandlePixelX(slots.offset + index, slots.count, width)
    const y = projectY(value, min, max, 0, plotBottom)
    if (previousX !== null) {
      drawLine(data, width, plotBottom + 1, previousX, previousY, x, y, color, 1.1)
    }
    previousX = x
    previousY = y
  }
}

export interface CandleBitmapOptions {
  candles: Candle[]
  pixelWidth: number
  pixelHeight: number
  /** Bottom slice of the bitmap reserved for volume bars; 0 disables the pane. */
  volumePixelHeight: number
  min: number
  max: number
  /** Pixel rows of the horizontal price grid lines. */
  gridYs: number[]
  /** Pixel row of the current-price guide, or null to omit it. */
  guideY: number | null
  guideColor: string
  /** Pixel column of the picked candle's marker, or null when nothing is picked. */
  selectionX?: number | null
  /** Indicator overlays, one value per candle; drawn under the candles. */
  lines?: IndicatorPolyline[]
  palette: ChartPalette
  /** Horizontal slot layout; defaults to spreading the candles across the full width. */
  slots?: CandleSlots
}

/** Rasterizes the candle plot (grid, guide, candles, volume) into an RGBA bitmap. */
export function renderCandleBitmap(options: CandleBitmapOptions): ChartBitmap {
  const width = Math.max(Math.floor(options.pixelWidth), 1)
  const height = Math.max(Math.floor(options.pixelHeight), 1)
  const pixels = new Uint8Array(width * height * 4)
  if (options.candles.length === 0) {
    return { width, height, pixels }
  }

  const volumeHeight = Math.max(Math.min(Math.floor(options.volumePixelHeight), height - 1), 0)
  const plotBottom = height - volumeHeight - 1
  const gridColor = parseHex(options.palette.gridColor, 0.28)
  for (const y of options.gridYs) {
    drawLine(pixels, width, height, 0, y, width - 1, y, gridColor, 1)
  }
  if (options.guideY !== null) {
    drawLine(pixels, width, height, 0, options.guideY, width - 1, options.guideY, parseHex(options.guideColor, 0.9), 1.2)
  }
  // Under the candles, so the one it marks is not painted over by its own marker.
  if (options.selectionX !== null && options.selectionX !== undefined) {
    const x = options.selectionX
    drawLine(pixels, width, height, x, 0, x, height - 1, parseHex(options.palette.selectionColor, 0.55), 1)
  }

  const slots = options.slots ?? candleSlots(options.candles.length, options.candles.length)
  // Overlays are context for the candles, so the candles draw over them.
  for (const line of options.lines ?? []) {
    drawPolyline(pixels, width, plotBottom, line, options.min, options.max, slots)
  }
  drawCandles(pixels, width, height, options.candles, 0, plotBottom, options.palette, options.min, options.max, slots)
  if (volumeHeight > 0) {
    drawVolume(pixels, width, height, options.candles, plotBottom + 1, height - 1, options.palette, slots)
  }

  return { width, height, pixels }
}
