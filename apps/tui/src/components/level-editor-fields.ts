import { fg, type KeyEvent, type TextChunk } from "@opentui/core"
import { TUI_THEME } from "../theme.ts"

type LevelEditorKind = "PRICE" | "PERCENT" | "ATR" | "TRAILING_PERCENT" | "TRAILING_ATR"

export function cycle<T>(values: readonly T[], current: T, direction: number): T {
  const index = values.indexOf(current)
  return values[(Math.max(0, index) + direction + values.length) % values.length] ?? current
}

export function valueLabel(kind: LevelEditorKind): string {
  if (kind === "PRICE") return "Price"
  if (kind === "PERCENT" || kind === "TRAILING_PERCENT") return "Distance (%)"
  return "Distance (ATR ×)"
}

export function distanceLabel(level: number, lastPrice: number | null): string {
  if (lastPrice === null || lastPrice <= 0) return ""
  const percent = ((level - lastPrice) / lastPrice) * 100
  return `  (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}% from market)`
}

export function fieldLine(label: string, value: string, active: boolean): TextChunk[] {
  return [
    fg(TUI_THEME.textMuted)(label.padEnd(16)),
    fg(active ? TUI_THEME.accent : TUI_THEME.textPrimary)(active ? `▸ ${value} ` : `  ${value}`),
    ...(active ? [fg(TUI_THEME.fieldBackground)(" ")] : []),
  ]
}

export function metricLine(label: string, value: string): TextChunk[] {
  return [fg(TUI_THEME.textMuted)(label.padEnd(16)), fg(TUI_THEME.textPrimary)(`  ${value}`)]
}

export function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function isDigitKey(key: KeyEvent): boolean {
  const value = key.sequence || key.name
  return value.length === 1 && value >= "0" && value <= "9"
}
