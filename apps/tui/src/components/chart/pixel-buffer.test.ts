import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  LAYER_DATA,
  LAYER_GRID,
  bufferToBrailleLines,
  createPixelBuffer,
  drawGuideLine,
  fillRect,
  setPixel,
} from "./pixel-buffer.ts"

test("maps dots to braille cells", () => {
  const buf = createPixelBuffer(4, 4) // two cells, one terminal row
  setPixel(buf, 0, 0, "#ff0000", LAYER_DATA) // top-left dot: 0x01
  setPixel(buf, 1, 3, "#ff0000", LAYER_DATA) // bottom-right dot: 0x80
  const lines = bufferToBrailleLines(buf)

  expect(lines).toHaveLength(1)
  const textLine = lines[0]!.map((chunk) => chunk.text).join("")
  expect(textLine.charCodeAt(0)).toBe(0x2800 + 0x01 + 0x80)
  expect(textLine[1]).toBe(" ")
})

test("higher layers hide lower-layer dots within a cell", () => {
  const buf = createPixelBuffer(2, 4) // single cell
  setPixel(buf, 0, 0, "#111111", LAYER_GRID)
  setPixel(buf, 1, 1, "#ff0000", LAYER_DATA)
  const cell = bufferToBrailleLines(buf)[0]![0]!

  expect(cell.text.charCodeAt(0)).toBe(0x2800 + 0x10) // only the data-layer dot
  expect(cell.fg?.equals(RGBA.fromHex("#ff0000"))).toBe(true)
})

test("merges adjacent identical cells into one chunk", () => {
  const buf = createPixelBuffer(8, 4) // four cells
  fillRect(buf, 0, 0, 7, 3, "#00ff00", LAYER_DATA)
  const line = bufferToBrailleLines(buf)[0]!

  expect(line).toHaveLength(1)
  expect(line[0]!.text).toBe("⣿⣿⣿⣿")
  expect(line[0]!.fg?.equals(RGBA.fromHex("#00ff00"))).toBe(true)
})

test("draws the guide as a dashed line", () => {
  const buf = createPixelBuffer(12, 4)
  drawGuideLine(buf, 1, "#365747")

  expect(buf.pixels[1]![0]).not.toBeNull()
  expect(buf.pixels[1]![1]).not.toBeNull()
  expect(buf.pixels[1]![2]).toBeNull()
  expect(buf.pixels[1]![3]).toBeNull()
  expect(buf.pixels[1]![4]).not.toBeNull()
})
