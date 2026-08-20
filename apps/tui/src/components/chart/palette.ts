import { TUI_THEME } from "../../theme.ts"
// Shared color palette for the braille and bitmap candle renderers.

export interface ChartPalette {
  candleUp: string
  candleDown: string
  wickUp: string
  wickDown: string
  volumeUp: string
  volumeDown: string
  gridColor: string
  guideUp: string
  guideDown: string
  // Vertical marker on the candle the trader picked out of the plot.
  selectionColor: string
}

/** Mixes two "#rrggbb" colors; ratio 0 returns `a`, 1 returns `b`. */
function blendHex(a: string, b: string, ratio: number): string {
  const parse = (hex: string) => {
    const h = hex.replace("#", "")
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as const
  }
  const [ar, ag, ab] = parse(a)
  const [br, bg, bb] = parse(b)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * ratio).toString(16).padStart(2, "0")
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`
}

export const UP_COLOR = TUI_THEME.positive
export const DOWN_COLOR = TUI_THEME.negative
const GRID_COLOR = TUI_THEME.border
const UP_GUIDE_COLOR = TUI_THEME.positiveGuide
const DOWN_GUIDE_COLOR = TUI_THEME.negativeGuide
// Bright enough to find at a glance, dim enough that the candle it marks still
// reads as the subject.
export const SELECTION_COLOR = TUI_THEME.chartSelection

// Wicks sit between the body color and plain text so single-dot strokes stay legible.
export const CHART_PALETTE: ChartPalette = {
  candleUp: UP_COLOR,
  candleDown: DOWN_COLOR,
  wickUp: blendHex(UP_COLOR, TUI_THEME.textBody, 0.35),
  wickDown: blendHex(DOWN_COLOR, TUI_THEME.textBody, 0.35),
  volumeUp: UP_GUIDE_COLOR,
  volumeDown: DOWN_GUIDE_COLOR,
  gridColor: GRID_COLOR,
  guideUp: UP_GUIDE_COLOR,
  guideDown: DOWN_GUIDE_COLOR,
  selectionColor: SELECTION_COLOR,
}
