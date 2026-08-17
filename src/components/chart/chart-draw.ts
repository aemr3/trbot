// Candle and volume drawing onto the braille pixel buffer.
import type { Candle } from "../../market/candle.ts"
import type { ChartPalette } from "./palette.ts"
import {
  bodySpan,
  candleSlots,
  getBarBodyWidth,
  getCandleBodyWidth,
  getCandleX,
  getScaledY,
  type CandleSlots,
  type IndicatorPolyline,
} from "./geometry.ts"
import { drawLine, fillRect, setPixel, LAYER_DATA, LAYER_FILL, type PixelBuffer } from "./pixel-buffer.ts"

function drawWickOutsideBody(
  buf: PixelBuffer,
  x: number,
  highY: number,
  lowY: number,
  bodyTop: number,
  bodyBottom: number,
  color: string,
): void {
  if (highY < bodyTop) {
    drawLine(buf, x, highY, x, bodyTop, color, LAYER_DATA)
  }
  if (bodyBottom < lowY) {
    drawLine(buf, x, bodyBottom, x, lowY, color, LAYER_DATA)
  }
}

/**
 * Draws filled candle bodies and wicks between the given pixel rows. `slots`
 * defaults to spreading the candles across the full buffer width.
 */
export function drawCandlesticks(
  buf: PixelBuffer,
  candles: Candle[],
  chartTop: number,
  chartBottom: number,
  palette: ChartPalette,
  min: number,
  max: number,
  slots: CandleSlots = candleSlots(candles.length, candles.length),
): void {
  const bodyWidth = getCandleBodyWidth(slots.count, buf.width)

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!
    const x = getCandleX(slots.offset + i, slots.count, buf.width)
    const [bodyLeft, bodyRight] = bodySpan(x, bodyWidth)
    const highY = getScaledY(candle.high, min, max, chartTop, chartBottom)
    const lowY = getScaledY(candle.low, min, max, chartTop, chartBottom)
    const openY = getScaledY(candle.open, min, max, chartTop, chartBottom)
    const closeY = getScaledY(candle.close, min, max, chartTop, chartBottom)
    const isUp = candle.close >= candle.open
    const wickColor = isUp ? palette.wickUp : palette.wickDown
    const bodyColor = isUp ? palette.candleUp : palette.candleDown

    const bodyTop = Math.min(openY, closeY)
    const bodyBottom = Math.max(openY, closeY)
    if (bodyTop === bodyBottom) {
      // Doji: full wick plus a two-pixel body sliver so the candle stays visible.
      drawLine(buf, x, highY, x, lowY, wickColor, LAYER_DATA)
      const dojiBottom = Math.min(bodyBottom + 1, chartBottom)
      const dojiTop = Math.max(chartTop, dojiBottom - 1)
      fillRect(buf, bodyLeft, dojiTop, bodyRight, dojiBottom, bodyColor, LAYER_DATA)
    } else {
      drawWickOutsideBody(buf, x, highY, lowY, bodyTop, bodyBottom, wickColor)
      fillRect(buf, bodyLeft, bodyTop, bodyRight, bodyBottom, bodyColor, LAYER_DATA)
    }
  }
}

/** Draws volume bars between the given pixel rows, colored by candle direction. */
export function drawVolumeBars(
  buf: PixelBuffer,
  candles: Candle[],
  yTop: number,
  yBottom: number,
  palette: ChartPalette,
  slots: CandleSlots = candleSlots(candles.length, candles.length),
): void {
  const maxVolume = Math.max(...candles.map((candle) => candle.volume ?? 0), 1)
  const volumeHeight = yBottom - yTop
  const barWidth = getBarBodyWidth(slots.count, buf.width)

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!
    const x = getCandleX(slots.offset + i, slots.count, buf.width)
    const barHeight = Math.round(((candle.volume ?? 0) / maxVolume) * volumeHeight)
    if (barHeight === 0) continue

    const [barLeft, barRight] = bodySpan(x, barWidth)
    const color = candle.close >= candle.open ? palette.volumeUp : palette.volumeDown
    fillRect(buf, barLeft, yBottom - barHeight, barRight, yBottom, color, LAYER_FILL)
  }
}

/**
 * Draws indicator overlays as polylines across the price pane. They go under
 * the candle layer: an overlay is context for the candles, and a braille cell
 * can only show one layer's dots, so the candle keeps the cell it shares.
 * A gap in the values breaks the line rather than bridging it.
 */
export function drawIndicatorLines(
  buf: PixelBuffer,
  lines: IndicatorPolyline[],
  chartTop: number,
  chartBottom: number,
  min: number,
  max: number,
  slots: CandleSlots,
): void {
  for (const line of lines) {
    let previousX: number | null = null
    let previousY = 0
    for (let index = 0; index < line.values.length; index++) {
      const value = line.values[index]
      if (value === null || value === undefined) {
        previousX = null
        continue
      }
      const x = getCandleX(slots.offset + index, slots.count, buf.width)
      const y = getScaledY(value, min, max, chartTop, chartBottom)
      if (previousX === null) setPixel(buf, x, y, line.color, LAYER_FILL)
      else drawLine(buf, previousX, previousY, x, y, line.color, LAYER_FILL)
      previousX = x
      previousY = y
    }
  }
}
