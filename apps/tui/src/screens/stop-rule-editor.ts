// Writes one protective level for an open position. It only produces a draft —
// the monitor decides when the level is reached, and nothing here trades.
import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import { z } from "zod"
import { CANDLE_INTERVAL_LABELS, FUTURES_INTERVALS, type CandleInterval } from "@trbot/market/candle.ts"
import type { AccountPosition } from "@trbot/trading/account.ts"
import {
  STOP_RULE_BASES,
  STOP_RULE_KINDS,
  STOP_RULE_ROLES,
  isAtrStopRule,
  stopPositionSide,
  validateStopRule,
  type StopRule,
  type StopRuleBasis,
  type StopRuleDraft,
  type StopRuleKind,
  type StopRuleRole,
} from "@trbot/trading/stop.ts"

const PANEL_BG = "#101010"
const FIELD_BG = "#2b2b2b"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c83ff"
const STOP_COLOR = "#ff6b6b"
const TARGET_COLOR = "#70d7a1"
const ERROR_COLOR = "#ff806f"

// Only the grains the futures feed actually serves. Offering 5m here would be
// a lie: the provider would answer with its 10m series and the rule would act
// on closes it never named.
const RULE_INTERVALS: CandleInterval[] = FUTURES_INTERVALS
const DEFAULT_RULE_INTERVAL: CandleInterval = FUTURES_INTERVALS[0] ?? "MIN_10"

const KIND_LABELS = {
  PRICE: "Price",
  PERCENT: "Percent from entry",
  ATR: "ATR from entry",
  TRAILING_PERCENT: "Trailing percent",
  TRAILING_ATR: "Trailing ATR",
} satisfies Record<StopRuleKind, string>

type EditorField = "position" | "role" | "kind" | "value" | "basis" | "interval" | "quantity" | "action"

export interface StopRuleEditorOptions {
  positions: AccountPosition[]
  // Present when editing; absent creates a rule for the selected position.
  rule?: StopRule
  lastPrice: (symbol: string) => number | null
  // Resolves the ATR the offset kinds measure with, or null when unavailable.
  atr?: (instrumentUid: string, interval: CandleInterval) => Promise<number | null>
  onSave: (draft: StopRuleDraft) => void
  onClose: () => void
  onError?: (cause: unknown) => void
}

export class StopRuleEditor {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private positionIndex = 0
  private role: StopRuleRole = "STOP"
  private kind: StopRuleKind = "PRICE"
  private basis: StopRuleBasis = "TOUCH"
  private interval: CandleInterval = DEFAULT_RULE_INTERVAL
  private valueText = ""
  private quantityText = ""
  private valueFresh = true
  private quantityFresh = true
  private field: EditorField = "value"
  private atrValue: number | null = null
  private atrRequest = 0
  private status: string | null = null
  private statusColor = MUTED_COLOR
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: StopRuleEditorOptions,
  ) {
    const rule = options.rule
    if (rule) {
      this.positionIndex = Math.max(0, options.positions.findIndex((position) => position.uid === rule.instrumentUid))
      this.role = rule.role
      this.kind = rule.kind
      this.basis = rule.basis
      this.interval = rule.interval ?? DEFAULT_RULE_INTERVAL
      this.valueText = String(rule.value)
      this.quantityText = rule.quantity === null ? "" : String(rule.quantity)
      this.atrValue = rule.atrValue
      this.valueFresh = false
    }

    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      onSizeChange: () => this.resizeModal(),
    })
    this.modal = new BoxRenderable(renderer, {
      width: 76,
      height: 24,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: this.role === "STOP" ? STOP_COLOR : TARGET_COLOR,
      flexDirection: "column",
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", flexGrow: 1, wrapMode: "word" })
    this.modal.add(this.content)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    void this.refreshAtr()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed) return true
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (key.name === "tab") {
      this.moveField(key.shift ? -1 : 1)
      return true
    }
    if (key.name === "up" || key.name === "down") {
      this.moveField(key.name === "up" ? -1 : 1)
      return true
    }
    if (key.name === "left" || key.name === "right" || key.name === "space") {
      this.cycleField(key.name === "left" ? -1 : 1)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.field === "action") this.save()
      else this.moveField(1)
      return true
    }
    if (key.name === "backspace") {
      this.editText((text) => text.slice(0, -1))
      return true
    }
    if (isDigitKey(key)) {
      this.editText((text) => text + (key.sequence || key.name))
      return true
    }
    if (this.field === "value" && (key.sequence === "." || key.sequence === "," || key.name === "." || key.name === ",")) {
      this.editText((text) => (text.includes(".") ? text : `${text}.`))
      return true
    }
    return true
  }

  private get position(): AccountPosition | undefined {
    return this.options.positions[this.positionIndex]
  }

  /** The draft as it currently stands; the single source for preview and save. */
  private draft(): StopRuleDraft | null {
    const position = this.position
    if (!position) return null
    return {
      id: this.options.rule?.id,
      instrumentUid: position.uid,
      symbol: position.symbol,
      displayName: position.displayName,
      side: stopPositionSide(position.quantity),
      role: this.role,
      kind: this.kind,
      value: Number(this.valueText),
      basis: this.basis,
      interval: this.needsInterval() ? this.interval : null,
      quantity: this.quantityText === "" ? null : Number(this.quantityText),
      referencePrice: position.averageCost,
      atrValue: isAtrStopRule(this.kind) ? this.atrValue : null,
    }
  }

  private needsInterval(): boolean {
    return this.basis === "CLOSE" || isAtrStopRule(this.kind)
  }

  private fields(): EditorField[] {
    const fields: EditorField[] = ["position", "role", "kind", "value", "basis"]
    if (this.needsInterval()) fields.push("interval")
    fields.push("quantity", "action")
    return fields
  }

  private moveField(direction: number): void {
    const fields = this.fields()
    const index = fields.indexOf(this.field)
    this.field = fields[(Math.max(0, index) + direction + fields.length) % fields.length] ?? "value"
    this.render()
  }

  private cycleField(direction: number): void {
    if (this.field === "position") {
      const count = this.options.positions.length
      if (count > 0) this.positionIndex = (this.positionIndex + direction + count) % count
    } else if (this.field === "role") {
      this.role = cycle(STOP_RULE_ROLES, this.role, direction)
      this.modal.borderColor = this.role === "STOP" ? STOP_COLOR : TARGET_COLOR
    } else if (this.field === "kind") {
      this.kind = cycle(STOP_RULE_KINDS, this.kind, direction)
      // Percent and ATR are different units; a value typed for one is wrong for
      // the other, so it starts fresh.
      this.valueText = ""
      this.valueFresh = true
      void this.refreshAtr()
    } else if (this.field === "basis") {
      this.basis = cycle(STOP_RULE_BASES, this.basis, direction)
      void this.refreshAtr()
    } else if (this.field === "interval") {
      this.interval = cycle(RULE_INTERVALS, this.interval, direction)
      void this.refreshAtr()
    } else return
    this.status = null
    this.render()
  }

  private editText(edit: (text: string) => string): void {
    if (this.field === "value") {
      if (this.valueFresh) this.valueText = ""
      this.valueFresh = false
      this.valueText = edit(this.valueText)
    } else if (this.field === "quantity") {
      if (this.quantityFresh) this.quantityText = ""
      this.quantityFresh = false
      this.quantityText = edit(this.quantityText)
    } else return
    this.status = null
    this.render()
  }

  /** Reads the ATR the offset kinds measure with; only ATR rules need it. */
  private async refreshAtr(): Promise<void> {
    const position = this.position
    const read = this.options.atr
    if (!read || !position || !isAtrStopRule(this.kind)) return
    const request = ++this.atrRequest
    try {
      const atr = await read(position.uid, this.interval)
      if (this.destroyed || request !== this.atrRequest) return
      this.atrValue = atr
      this.render()
    } catch (error) {
      if (this.destroyed || request !== this.atrRequest) return
      this.options.onError?.(error)
    }
  }

  private save(): void {
    const draft = this.draft()
    if (!draft) {
      this.fail("No open position to protect")
      return
    }
    const problem = validateStopRule(draft, this.options.lastPrice(draft.symbol))
    if (problem) {
      this.fail(problem)
      return
    }
    this.options.onSave(draft)
  }

  private fail(message: string): void {
    this.status = message
    this.statusColor = ERROR_COLOR
    this.render()
  }

  private resizeModal(): void {
    this.modal.width = Math.min(76, Math.max(40, this.root.width - 2))
    this.modal.height = Math.min(24, Math.max(12, this.root.height - 2))
  }

  private render(): void {
    if (this.destroyed) return
    const draft = this.draft()
    const position = this.position
    const lastPrice = draft ? this.options.lastPrice(draft.symbol) : null
    const level = draft ? previewLevel(draft) : null
    const roleColor = this.role === "STOP" ? STOP_COLOR : TARGET_COLOR

    const chunks: TextChunk[] = [
      fg(roleColor)(this.options.rule ? "Edit protective level" : "New protective level"),
      fg(MUTED_COLOR)("  ·  the app watches, you confirm every exit"),
      fg(VALUE_COLOR)("\n\n"),
      ...fieldLine(
        "Position",
        position
          ? `${position.displayName}  ${formatQuantity(position.quantity)}x @ ${formatNumber(position.averageCost)}`
          : "No open positions",
        this.field === "position",
      ),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Level", this.role === "STOP" ? "Stop (cap the loss)" : "Target (take the profit)", this.field === "role"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Measured by", KIND_LABELS[this.kind], this.field === "kind"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine(valueLabel(this.kind), this.valueText || "—", this.field === "value"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine(
        "Triggers on",
        this.basis === "TOUCH" ? "Any trade through the level" : "A candle closing beyond it",
        this.field === "basis",
      ),
      fg(VALUE_COLOR)("\n"),
    ]
    if (this.needsInterval()) {
      chunks.push(...fieldLine("Timeframe", CANDLE_INTERVAL_LABELS[this.interval], this.field === "interval"), fg(VALUE_COLOR)("\n"))
    }
    chunks.push(
      ...fieldLine("Contracts", this.quantityText === "" ? "Whole position" : this.quantityText, this.field === "quantity"),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Market", formatNumber(lastPrice)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine(
        "Level",
        level === null
          ? "—"
          : `${formatNumber(level)}${distanceLabel(level, lastPrice)}`,
      ),
      fg(VALUE_COLOR)("\n"),
    )
    if (isAtrStopRule(this.kind)) {
      chunks.push(...metricLine("ATR", this.atrValue === null ? "unavailable" : formatNumber(this.atrValue)), fg(VALUE_COLOR)("\n"))
    }
    chunks.push(
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Save rule", this.field === "action" ? "Press Enter" : "Enter", this.field === "action"),
    )
    if (this.status) chunks.push(fg(this.statusColor)(`\n\n${this.status}`))
    chunks.push(fg(MUTED_COLOR)("\n\nTab/↑/↓ field · ←/→ change · digits value · Enter save · Esc close"))
    this.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }
}

/** The level a draft resolves to, for the preview line. */
function previewLevel(draft: StopRuleDraft): number | null {
  if (!Number.isFinite(draft.value) || draft.value <= 0) return null
  if (draft.kind === "PRICE") return draft.value
  const anchor = draft.referencePrice
  if (anchor === null || anchor <= 0) return null
  const distance = isAtrStopRule(draft.kind)
    ? (draft.atrValue ?? 0) * draft.value
    : anchor * (draft.value / 100)
  if (distance <= 0) return null
  const below = draft.side === "LONG" ? draft.role === "STOP" : draft.role === "TARGET"
  const level = below ? anchor - distance : anchor + distance
  return level > 0 ? level : null
}

function valueLabel(kind: StopRuleKind): string {
  if (kind === "PRICE") return "Price"
  if (kind === "PERCENT" || kind === "TRAILING_PERCENT") return "Distance (%)"
  return "Distance (ATR ×)"
}

function distanceLabel(level: number, lastPrice: number | null): string {
  if (lastPrice === null || lastPrice <= 0) return ""
  const percent = ((level - lastPrice) / lastPrice) * 100
  return `  (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}% from market)`
}

function cycle<T>(values: readonly T[], current: T, direction: number): T {
  const index = values.indexOf(current)
  return values[(Math.max(0, index) + direction + values.length) % values.length] ?? current
}

function fieldLine(label: string, value: string, active: boolean): TextChunk[] {
  return [
    fg(MUTED_COLOR)(label.padEnd(16)),
    fg(active ? EMPHASIS_COLOR : VALUE_COLOR)(active ? `▸ ${value} ` : `  ${value}`),
    ...(active ? [fg(FIELD_BG)(" ")] : []),
  ]
}

function metricLine(label: string, value: string): TextChunk[] {
  return [fg(MUTED_COLOR)(label.padEnd(16)), fg(VALUE_COLOR)(`  ${value}`)]
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatQuantity(value: number): string {
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })
}

function isDigitKey(key: KeyEvent): boolean {
  const value = key.sequence || key.name
  const parsed = z.string().length(1).safeParse(value)
  return parsed.success && parsed.data >= "0" && parsed.data <= "9"
}
