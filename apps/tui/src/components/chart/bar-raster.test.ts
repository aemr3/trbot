import { expect, test } from "bun:test"
import { barSlot, renderBarBitmap, type PerformanceBar } from "./bar-raster.ts"

const UP = "#70d7a1"
const DOWN = "#ff6b6b"
const ZERO = "#505050"

function bitmap(bars: PerformanceBar[], width = 60, height = 24) {
  return renderBarBitmap({ bars, width, height, upColor: UP, downColor: DOWN, zeroColor: ZERO })
}

/** Rows carrying the colour anywhere across the width. */
function rowsWithColor(
  frame: { width: number; height: number; pixels: Uint8Array },
  hex: string,
): number[] {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
  const rows: number[] = []
  for (let row = 0; row < frame.height; row++) {
    for (let column = 0; column < frame.width; column++) {
      const index = (row * frame.width + column) * 4
      if (frame.pixels[index] === red && frame.pixels[index + 1] === green && frame.pixels[index + 2] === blue) {
        rows.push(row)
        break
      }
    }
  }
  return rows
}

/** Height of the bar occupying the given slot, counted in pixels. */
function barHeight(
  frame: { width: number; height: number; pixels: Uint8Array },
  slot: number,
  count: number,
  hex: string,
): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
  const column = Math.floor((slot + 0.5) * (frame.width / count))
  let pixels = 0
  for (let row = 0; row < frame.height; row++) {
    const index = (row * frame.width + column) * 4
    if (frame.pixels[index] === red && frame.pixels[index + 1] === green && frame.pixels[index + 2] === blue) {
      pixels++
    }
  }
  return pixels
}

test("gains rise from the zero line and losses hang below it", () => {
  const frame = bitmap([{ value: 1_000, label: "10" }, { value: -1_000, label: "11" }])
  const zero = rowsWithColor(frame, ZERO)
  const gains = rowsWithColor(frame, UP)
  const losses = rowsWithColor(frame, DOWN)

  // One row of zero line, showing in the gaps between the bars that sit on it.
  expect(zero).toHaveLength(1)
  expect(Math.max(...gains)).toBeLessThanOrEqual(zero[0]!)
  expect(Math.min(...losses)).toBeGreaterThan(zero[0]!)
})

test("scales both directions against the same worst case", () => {
  const frame = bitmap([{ value: 3_000, label: "10" }, { value: -1_500, label: "11" }])

  // Half the magnitude, half the bar — a loss is not rescaled to fill its own
  // half, which would make a small loss look like a large one.
  const gain = barHeight(frame, 0, 2, UP)
  const loss = barHeight(frame, 1, 2, DOWN)
  expect(loss).toBeGreaterThan(gain * 0.4)
  expect(loss).toBeLessThan(gain * 0.6)
})

test("draws a quiet day as a stub rather than as nothing", () => {
  // Against a large peak this bar rounds to zero pixels; a hole in the series
  // reads as a missing day rather than a flat one.
  const frame = bitmap([{ value: 100_000, label: "10" }, { value: 1, label: "11" }])

  expect(barHeight(frame, 1, 2, UP)).toBeGreaterThan(0)
})

test("survives a range with nothing in it", () => {
  const empty = bitmap([])
  expect(empty.pixels.every((value) => value === 0)).toBeTrue()

  // Every day flat: the bars are stubs, and the zero line still anchors them.
  const flat = bitmap([{ value: 0, label: "10" }, { value: 0, label: "11" }])
  expect(rowsWithColor(flat, ZERO)).toHaveLength(1)
})

test("marks the selected bar through the empty side of the chart", () => {
  const guide = "#59606c"
  const bars = [{ value: -1_000, label: "10" }, { value: 1_000, label: "11" }]
  const frame = renderBarBitmap({
    bars,
    width: 60,
    height: 24,
    upColor: UP,
    downColor: DOWN,
    zeroColor: ZERO,
    selectedIndex: 0,
    guideColor: guide,
  })
  const column = barSlot(0, bars.length, frame.width).center
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(guide.slice(offset, offset + 2), 16))

  expect(Array.from(frame.pixels.slice(column * 4, column * 4 + 3))).toEqual([red, green, blue])
})
