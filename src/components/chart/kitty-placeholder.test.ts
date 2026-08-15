import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  KittyPlaceholderImages,
  encodeTransmit,
  encodeVirtualPlacement,
  placeholderGrid,
  wrapTmuxPassthrough,
} from "./kitty-placeholder.ts"

test("doubles escapes inside the tmux passthrough wrapper", () => {
  expect(wrapTmuxPassthrough("\x1b_Ga=t\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Ga=t\x1b\x1b\\\x1b\\")
})

test("transmits RGBA bitmaps as chunked zlib payloads", () => {
  const bitmap = { width: 2, height: 2, pixels: new Uint8Array(16).fill(128) }
  const sequences = encodeTransmit(bitmap, 42)

  expect(sequences).toHaveLength(1)
  expect(sequences[0]).toStartWith("\x1b_Ga=t,f=32,o=z,s=2,v=2,i=42,q=2,m=0;")
  expect(sequences[0]).toEndWith("\x1b\\")
})

test("creates a virtual placement fitted to the cell grid", () => {
  expect(encodeVirtualPlacement(42, 80, 20)).toBe("\x1b_Ga=p,U=1,i=42,p=1,c=80,r=20,q=2\x1b\\")
})

test("encodes cell positions with 0-based diacritics and the id as foreground", () => {
  const grid = placeholderGrid(0x0000ff, 2, 2)
  const lines = grid.chunks.filter((chunk) => chunk.text !== "\n")

  expect(lines).toHaveLength(2)
  const firstRow = [...lines[0]!.text]
  // Cell (0,0): placeholder, row diacritic 0 (U+0305), column diacritic 0.
  expect(firstRow.slice(0, 3).map((ch) => ch.codePointAt(0))).toEqual([0x10eeee, 0x0305, 0x0305])
  // Cell (0,1): column diacritic 1 (U+030D).
  expect(firstRow.slice(3, 6).map((ch) => ch.codePointAt(0))).toEqual([0x10eeee, 0x0305, 0x030d])
  // Row 1 uses row diacritic 1.
  expect([...lines[1]!.text][1]!.codePointAt(0)).toBe(0x030d)
  expect(lines[0]!.fg?.equals(RGBA.fromInts(0, 0, 255, 255))).toBe(true)
})

test("alternates two image ids and deletes them on clear", () => {
  const written: string[] = []
  const images = new KittyPlaceholderImages((data) => written.push(data))
  const bitmap = { width: 2, height: 2, pixels: new Uint8Array(16) }

  images.render(bitmap, 4, 2)
  images.render(bitmap, 4, 2)
  images.render(bitmap, 4, 2)
  expect(written).toHaveLength(3)
  const idOf = (sequence: string) => sequence.match(/i=(\d+)/)?.[1]
  expect(idOf(written[0]!)).toBe(idOf(written[2]!))
  expect(idOf(written[0]!)).not.toBe(idOf(written[1]!))
  expect(written[0]).toContain("\x1bPtmux;")
  expect(written[0]).toContain("U=1")

  images.clear()
  expect(written[3]).toContain("a=d,d=I")
})
