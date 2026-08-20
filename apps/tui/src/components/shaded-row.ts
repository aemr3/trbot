import { TUI_THEME } from "../theme.ts"
import { bg, fg, type TextChunk } from "@opentui/core"

// A run of text carrying one foreground colour. Rows are built from these so a
// size bar can be laid across them without losing each column's own colour.
export interface Segment {
  text: string
  color: string
}

export function segment(text: string, color: string): Segment {
  return { text, color }
}

export function plain(segments: Segment[]): TextChunk[] {
  return segments.filter((part) => part.text.length > 0).map((part) => fg(part.color)(part.text))
}

// Paints a background across columns `from` up to `to`, splitting whichever
// segments straddle those edges. This is what turns a row of figures into a bar
// chart without giving up the per-column foreground colours.
export function shade(segments: Segment[], from: number, to: number, background: string): TextChunk[] {
  if (to <= from) return plain(segments)
  const chunks: TextChunk[] = []
  let column = 0
  for (const part of segments) {
    for (const [text, shaded] of splitSegment(part.text, column, from, to)) {
      if (text.length === 0) continue
      chunks.push(shaded ? fg(part.color)(bg(background)(text)) : fg(part.color)(text))
    }
    column += part.text.length
  }
  return chunks
}

function splitSegment(text: string, column: number, from: number, to: number): [string, boolean][] {
  const start = Math.max(0, Math.min(text.length, from - column))
  const end = Math.max(0, Math.min(text.length, to - column))
  return [
    [text.slice(0, start), false],
    [text.slice(start, end), true],
    [text.slice(end), false],
  ]
}

// Pads or trims a row to an exact column count. Aligning to "start" keeps the
// right-hand end fixed, which is what right-aligned number columns need.
export function padSegments(segments: Segment[], width: number, align: "start" | "end"): Segment[] {
  const length = segments.reduce((total, part) => total + part.text.length, 0)
  if (length === width) return segments
  if (length > width) return trimSegments(segments, width, align)
  const filler = segment(" ".repeat(width - length), FILLER_COLOR)
  return align === "start" ? [filler, ...segments] : [...segments, filler]
}

function trimSegments(segments: Segment[], width: number, align: "start" | "end"): Segment[] {
  const ordered = align === "start" ? [...segments].reverse() : segments
  const kept: Segment[] = []
  let remaining = width
  for (const part of ordered) {
    if (remaining <= 0) break
    const text = align === "start" ? part.text.slice(-remaining) : part.text.slice(0, remaining)
    remaining -= text.length
    kept.push(segment(text, part.color))
  }
  return align === "start" ? kept.reverse() : kept
}

// Scales a value against the largest in its column, never vanishing entirely so
// a small-but-present figure still reads as a bar.
export function barWidth(value: number, maxValue: number, width: number): number {
  if (value <= 0 || maxValue <= 0) return 0
  return Math.max(1, Math.min(width, Math.round((value / maxValue) * width)))
}

// Shortens a name to fit, marking the cut so a truncated value is never read as
// the whole one.
export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

const FILLER_COLOR = TUI_THEME.textMuted
