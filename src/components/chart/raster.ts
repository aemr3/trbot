// True-pixel candle chart rasterizer for terminals that support the kitty
// graphics protocol: anti-aliased strokes and alpha-blended bodies drawn into
// a raw RGBA bitmap.
import type { Candle } from "../../market/candle.ts"
import type { ChartPalette } from "./palette.ts"

export interface CandleChartBitmap {
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
  for (let y = Math.max(Math.floor(top), 0); y <= Math.min(Math.ceil(bottom), height - 1); y++) {
    for (let x = Math.max(Math.floor(left), 0); x <= Math.min(Math.ceil(right), width - 1); x++) {
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
): void {
  const bodyWidth = getBodyWidth(candles.length, width)

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const x = getCandlePixelX(index, candles.length, width)
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
      // Doji: full wick plus a thin horizontal body stroke.
      drawLine(data, width, height, x, highY, x, lowY, wickColor, 1.2)
      drawLine(data, width, height, x - bodyWidth / 2, bodyTop, x + bodyWidth / 2, bodyTop, bodyColor, 1.5)
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
): void {
  if (bottom < top) return

  const maxVolume = Math.max(...candles.map((candle) => candle.volume ?? 0), 1)
  const spacing = width / Math.max(candles.length, 1)
  const barWidth = clamp(spacing * 0.72, 1, Math.max(spacing, 1))

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!
    const heightRatio = (candle.volume ?? 0) / maxVolume
    if (heightRatio <= 0) continue
    const x = projectX(index, candles.length, 0, width - 1)
    const barTop = lerp(bottom, top, heightRatio)
    const color = parseHex(candle.close >= candle.open ? palette.volumeUp : palette.volumeDown, 0.6)
    fillRect(data, width, height, x - barWidth / 2, barTop, x + barWidth / 2, bottom, color, 0.8)
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
  palette: ChartPalette
}

/** Rasterizes the candle plot (grid, guide, candles, volume) into an RGBA bitmap. */
export function renderCandleBitmap(options: CandleBitmapOptions): CandleChartBitmap {
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

  drawCandles(pixels, width, height, options.candles, 0, plotBottom, options.palette, options.min, options.max)
  if (volumeHeight > 0) {
    drawVolume(pixels, width, height, options.candles, plotBottom + 1, height - 1, options.palette)
  }

  return { width, height, pixels }
}
