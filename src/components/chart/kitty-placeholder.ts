// Kitty graphics inside tmux via "unicode placeholders": cursor-positioned
// image placements land in the wrong place through tmux, but a *virtual*
// placement (U=1) attaches the image to placeholder text cells (U+10EEEE plus
// row/column diacritics, with the image id encoded in the foreground color).
// tmux moves those cells like any other text, so positioning is exact; the
// outer terminal materializes the image over them.
import { deflateSync } from "node:zlib"
import { RGBA, StyledText, type TextChunk } from "@opentui/core"
import { ROW_COLUMN_DIACRITICS } from "./kitty-diacritics.ts"
import type { CandleChartBitmap } from "./raster.ts"

const PLACEHOLDER = String.fromCodePoint(0x10eeee)
const APC_START = "\x1b_G"
const APC_END = "\x1b\\"
const CHUNK_SIZE = 4096

/** tmux forwards an escape sequence to the outer terminal when it is wrapped
 *  in a DCS passthrough with every ESC doubled (requires allow-passthrough). */
export function wrapTmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
}

/** Chunked RGBA transmission (f=32, zlib) for the given image id. */
export function encodeTransmit(bitmap: CandleChartBitmap, imageId: number): string[] {
  // Level 3 keeps compression cheap enough for live-tick retransmits.
  const compressed = deflateSync(bitmap.pixels, { level: 3 })
  const base64 = Buffer.from(compressed).toString("base64")
  const chunks: string[] = []
  for (let index = 0; index < base64.length; index += CHUNK_SIZE) {
    chunks.push(base64.slice(index, index + CHUNK_SIZE))
  }
  if (chunks.length === 0) chunks.push("")

  return chunks.map((chunk, index) => {
    const more = index === chunks.length - 1 ? 0 : 1
    const control = index === 0
      ? `a=t,f=32,o=z,s=${bitmap.width},v=${bitmap.height},i=${imageId},q=2,m=${more}`
      : `m=${more}`
    return `${APC_START}${control};${chunk}${APC_END}`
  })
}

/** Virtual placement: fits the image to a cols x rows cell grid (U=1). */
export function encodeVirtualPlacement(imageId: number, cols: number, rows: number): string {
  return `${APC_START}a=p,U=1,i=${imageId},p=1,c=${cols},r=${rows},q=2${APC_END}`
}

/** Deletes the image and its placements. */
export function encodeDelete(imageId: number): string {
  return `${APC_START}a=d,d=I,i=${imageId},q=2${APC_END}`
}

/** Placeholder text grid displaying `imageId`, one styled row per terminal row. */
export function placeholderGrid(imageId: number, cols: number, rows: number): StyledText {
  const fg = RGBA.fromInts((imageId >> 16) & 0xff, (imageId >> 8) & 0xff, imageId & 0xff, 255)
  const gridCols = Math.min(cols, ROW_COLUMN_DIACRITICS.length)
  const gridRows = Math.min(rows, ROW_COLUMN_DIACRITICS.length)
  const chunks: TextChunk[] = []

  for (let row = 0; row < gridRows; row++) {
    if (row > 0) chunks.push({ __isChunk: true, text: "\n" })
    const rowDiacritic = String.fromCodePoint(ROW_COLUMN_DIACRITICS[row]!)
    let text = ""
    for (let col = 0; col < gridCols; col++) {
      text += PLACEHOLDER + rowDiacritic + String.fromCodePoint(ROW_COLUMN_DIACRITICS[col]!)
    }
    chunks.push({ __isChunk: true, text, fg })
  }
  return new StyledText(chunks)
}

let nextImageId = 0xbee000 // arbitrary base; stays below 2^24 so no third diacritic

/**
 * Uploads chart bitmaps through tmux and hands back the placeholder text that
 * displays them. Two image ids alternate so the frame still on screen is never
 * overwritten mid-paint; images are only deleted on clear().
 */
export class KittyPlaceholderImages {
  private readonly imageIds: readonly [number, number] = [nextImageId++, nextImageId++]
  private activeSlot: 0 | 1 | null = null

  // Under an active OpenTUI renderer, pass the renderer's writeOut so payloads
  // serialize with frame output; the raw-stdout default is for tests only.
  constructor(private readonly write: (data: string) => void = (data) => void process.stdout.write(data)) {}

  render(bitmap: CandleChartBitmap, cols: number, rows: number): StyledText {
    const slot = this.activeSlot === 0 ? 1 : 0
    const imageId = this.imageIds[slot]!
    const sequences = [...encodeTransmit(bitmap, imageId), encodeVirtualPlacement(imageId, cols, rows)]
    this.write(sequences.map(wrapTmuxPassthrough).join(""))
    this.activeSlot = slot
    return placeholderGrid(imageId, cols, rows)
  }

  clear(): void {
    if (this.activeSlot === null) return
    this.write(this.imageIds.map((imageId) => wrapTmuxPassthrough(encodeDelete(imageId))).join(""))
    this.activeSlot = null
  }
}
