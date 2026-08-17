// Maps candle indexes and prices onto pixel coordinates (braille dots or
// bitmap pixels).

/** Evenly distributes point `index` across `width` pixels, inset by the paddings. */
export function getSeriesPosition(
  index: number,
  pointCount: number,
  width: number,
  startPadding = 0,
  endPadding = startPadding,
): number {
  const start = Math.max(startPadding, 0)
  const end = Math.max(start, width - 1 - Math.max(endPadding, 0))
  if (pointCount <= 1) return Math.round((start + end) / 2)
  return Math.round(start + (index / (pointCount - 1)) * (end - start))
}

/** Linear price-to-pixel-row mapping; `max` lands on `chartTop`, `min` on `chartBottom`. */
export function getScaledY(value: number, min: number, max: number, chartTop: number, chartBottom: number): number {
  const range = max - min || 1
  const chartH = chartBottom - chartTop
  return chartTop + Math.round((1 - (value - min) / range) * chartH)
}

/**
 * Horizontal layout of a candle window: `count` evenly spaced slots with the
 * visible candles right-aligned into the last of them. An under-filled window
 * (a couple of candles at the open, or a long timeframe with little history)
 * keeps its slots at the zoom spacing and leaves the left side empty instead of
 * stretching a handful of candles across the whole plot.
 */
export interface CandleSlots {
  /** Slots the plot is divided into; `>= visibleCount`. */
  count: number
  /** Slots skipped before the first visible candle. */
  offset: number
}

/** Right-aligns `visibleCount` candles into at least `slotCount` layout slots. */
export function candleSlots(visibleCount: number, slotCount: number): CandleSlots {
  const count = Math.max(Math.floor(slotCount), visibleCount, 1)
  return { count, offset: count - visibleCount }
}

/** Candle body width in pixels: ~half the spacing, at least 2 px. Uncapped so
 *  zoomed-in candles keep their body/gap proportion. */
export function getCandleBodyWidth(pointCount: number, bufWidth: number): number {
  if (pointCount <= 1) return 4
  const spacing = bufWidth / pointCount
  return Math.max(Math.round(spacing * 0.5), 2)
}

/** Volume bar width in pixels: ~45% of the spacing, at least 1 px. */
export function getBarBodyWidth(pointCount: number, bufWidth: number): number {
  if (pointCount <= 1) return 4
  const spacing = bufWidth / pointCount
  return Math.max(Math.round(spacing * 0.45), 1)
}

/** Left/right pixel columns of a `width`-wide body centered on `x` (left-biased when even). */
export function bodySpan(x: number, width: number): [number, number] {
  const left = x - Math.floor((width - 1) / 2)
  return [left, left + width - 1]
}

/** Center pixel column of a candle, inset so the widest body stays in bounds. */
export function getCandleX(index: number, pointCount: number, bufWidth: number): number {
  const pad = Math.ceil(getCandleBodyWidth(pointCount, bufWidth) / 2)
  return getSeriesPosition(index, pointCount, bufWidth, pad, pad)
}

/** Terminal column above a candle's center, for aligning time-axis ticks. */
export function getCandleColumn(index: number, pointCount: number, widthCells: number): number {
  if (widthCells <= 1) return 0
  const x = getCandleX(index, pointCount, Math.max(widthCells * 2, 1))
  return Math.min(Math.max(Math.floor(x / 2), 0), widthCells - 1)
}
