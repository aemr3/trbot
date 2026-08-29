import { TUI_THEME } from "../theme.ts"
// Writes one protective level for an open position. It only produces a draft —
// the monitor decides when the level is reached, and nothing here trades.
import { StyledText, fg, type BoxRenderable, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import {
  CANDLE_INTERVAL_LABELS,
  DEFAULT_RULE_INTERVAL,
  RULE_INTERVALS,
  type CandleInterval,
} from "@trbot/market/candle.ts"
import type { AccountPosition } from "@trbot/trading/account.ts"
import {
  STOP_RULE_BASES,
  STOP_RULE_KINDS,
  STOP_RULE_ROLES,
  isAtrStopRule,
  resolveStopRuleDraftLevel,
  stopPositionSide,
  validateStopRule,
  type StopRule,
  type StopRuleBasis,
  type StopRuleDraft,
  type StopRuleKind,
  type StopRuleRole,
} from "@trbot/trading/stop.ts"
import {
  cycle,
  distanceLabel,
  fieldLine,
  formatNumber,
  metricLine,
  valueLabel,
} from "../components/level-editor-fields.ts"
import { LevelEditorFrame } from "../components/level-editor-frame.ts"

const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const STOP_COLOR = TUI_THEME.negative
const TARGET_COLOR = TUI_THEME.positive
const ERROR_COLOR = TUI_THEME.softError

// Only the grains the futures feed actually serves. Offering 5m here would be
// a lie: the provider would answer with its 10m series and the rule would act
// on closes it never named.

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
  onSave: (draft: StopRuleDraft) => Promise<void>
  onClose: () => void
  onError?: (cause: unknown) => void
}

export class StopRuleEditor {
  readonly root: BoxRenderable

  private readonly frame: LevelEditorFrame<EditorField>
  private positionIndex = 0
  private role: StopRuleRole = "STOP"
  private kind: StopRuleKind = "PRICE"
  private basis: StopRuleBasis = "TOUCH"
  private interval: CandleInterval = DEFAULT_RULE_INTERVAL
  private valueText = ""
  private quantityText = ""
  private valueFresh = true
  private quantityFresh = true
  private atrValue: number | null = null
  private atrRequest = 0
  private status: string | null = null
  private statusColor = MUTED_COLOR
  private saving = false
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

    this.frame = new LevelEditorFrame(renderer, {
      fields: () => this.fields(),
      initialField: "value",
      valueField: "value",
      actionField: "action",
      borderColor: this.role === "STOP" ? STOP_COLOR : TARGET_COLOR,
      onClose: options.onClose,
      onFieldChange: () => this.render(),
      onCycle: (field, direction) => this.cycleField(field, direction),
      onEdit: (field, edit) => this.editText(field, edit),
      onSave: () => this.save(),
    })
    this.root = this.frame.root
    this.render()
  }

  mount(): void {
    void this.refreshAtr()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.frame.destroy()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.saving) return true
    return this.frame.handleKey(key)
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

  private cycleField(field: EditorField, direction: number): void {
    if (field === "position") {
      const count = this.options.positions.length
      if (count > 0) this.positionIndex = (this.positionIndex + direction + count) % count
    } else if (field === "role") {
      this.role = cycle(STOP_RULE_ROLES, this.role, direction)
      this.frame.borderColor = this.role === "STOP" ? STOP_COLOR : TARGET_COLOR
    } else if (field === "kind") {
      this.kind = cycle(STOP_RULE_KINDS, this.kind, direction)
      // Percent and ATR are different units; a value typed for one is wrong for
      // the other, so it starts fresh.
      this.valueText = ""
      this.valueFresh = true
      void this.refreshAtr()
    } else if (field === "basis") {
      this.basis = cycle(STOP_RULE_BASES, this.basis, direction)
      void this.refreshAtr()
    } else if (field === "interval") {
      this.interval = cycle(RULE_INTERVALS, this.interval, direction)
      void this.refreshAtr()
    } else return
    this.status = null
    this.render()
  }

  private editText(field: EditorField, edit: (text: string) => string): void {
    if (field === "value") {
      if (this.valueFresh) this.valueText = ""
      this.valueFresh = false
      this.valueText = edit(this.valueText)
    } else if (field === "quantity") {
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

  private async save(): Promise<void> {
    if (this.saving) return
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
    this.saving = true
    this.status = "Saving rule…"
    this.statusColor = MUTED_COLOR
    this.render()
    try {
      await this.options.onSave(draft)
      if (this.destroyed) return
      this.status = null
      this.options.onClose()
    } catch (error) {
      if (this.destroyed) return
      this.options.onError?.(error)
      this.fail(error instanceof Error ? error.message : "Could not save the rule")
    } finally {
      this.saving = false
    }
  }

  private fail(message: string): void {
    this.status = message
    this.statusColor = ERROR_COLOR
    this.render()
  }

  private render(): void {
    if (this.destroyed) return
    const draft = this.draft()
    const position = this.position
    const lastPrice = draft ? this.options.lastPrice(draft.symbol) : null
    const level = draft ? resolveStopRuleDraftLevel(draft) : null
    const roleColor = this.role === "STOP" ? STOP_COLOR : TARGET_COLOR

    const chunks: TextChunk[] = [
      fg(roleColor)(this.options.rule ? "Edit protective level" : "New protective level"),
      fg(VALUE_COLOR)("\n\n"),
      ...fieldLine(
        "Position",
        position
          ? `${position.displayName}  ${formatQuantity(position.quantity)}x @ ${formatNumber(position.averageCost)}`
          : "No open positions",
        this.frame.field === "position",
      ),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Level", this.role === "STOP" ? "Stop (cap the loss)" : "Target (take the profit)", this.frame.field === "role"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Measured by", KIND_LABELS[this.kind], this.frame.field === "kind"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine(valueLabel(this.kind), this.valueText || "—", this.frame.field === "value"),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine(
        "Triggers on",
        this.basis === "TOUCH" ? "Any trade through the level" : "A candle closing beyond it",
        this.frame.field === "basis",
      ),
      fg(VALUE_COLOR)("\n"),
    ]
    if (this.needsInterval()) {
      chunks.push(...fieldLine("Timeframe", CANDLE_INTERVAL_LABELS[this.interval], this.frame.field === "interval"), fg(VALUE_COLOR)("\n"))
    }
    chunks.push(
      ...fieldLine("Contracts", this.quantityText === "" ? "Whole position" : this.quantityText, this.frame.field === "quantity"),
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
      ...fieldLine("Save rule", this.frame.field === "action" ? "Press Enter" : "Enter", this.frame.field === "action"),
    )
    if (this.status) chunks.push(fg(this.statusColor)(`\n\n${this.status}`))
    chunks.push(fg(MUTED_COLOR)("\n\nTab/↑/↓ field · ←/→ change · digits value · Enter save · Esc close"))
    this.frame.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }
}

function formatQuantity(value: number): string {
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })
}
