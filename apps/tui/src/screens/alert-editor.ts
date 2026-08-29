import { TUI_THEME } from "../theme.ts"
// Writes one price level the trader wants to be told about. It only produces a
// draft — the monitor decides when the level is reached, and nothing here, or
// anywhere downstream of it, trades.
import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import {
  ALERT_BASES,
  ALERT_KINDS,
  ALERT_REPEATS,
  isAtrAlert,
  validatePriceAlert,
  type PriceAlert,
  type PriceAlertBasis,
  type PriceAlertDraft,
  type PriceAlertKind,
  type PriceAlertRepeat,
} from "@trbot/market/alert.ts"
import {
  CANDLE_INTERVAL_LABELS,
  DEFAULT_RULE_INTERVAL,
  RULE_INTERVALS,
  type CandleInterval,
} from "@trbot/market/candle.ts"
import { LEVEL_DIRECTIONS, type LevelDirection } from "@trbot/market/price-level.ts"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import {
  cycle,
  distanceLabel,
  fieldLine,
  formatNumber,
  isDigitKey,
  metricLine,
  valueLabel,
} from "../components/level-editor-fields.ts"

const PANEL_BG = TUI_THEME.appBackground
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const ABOVE_COLOR = TUI_THEME.positive
const BELOW_COLOR = TUI_THEME.negative
const ERROR_COLOR = TUI_THEME.softError

// Only the grains the futures feed actually serves. Offering 5m here would be a
// lie: the provider would answer with its 10m series and the alert would fire
// on closes it never named.
const ALERT_INTERVALS: CandleInterval[] = RULE_INTERVALS
const DEFAULT_ALERT_INTERVAL: CandleInterval = DEFAULT_RULE_INTERVAL

const KIND_LABELS = {
  PRICE: "Price",
  PERCENT: "Percent from market",
  ATR: "ATR from market",
  TRAILING_PERCENT: "Trailing percent",
  TRAILING_ATR: "Trailing ATR",
} satisfies Record<PriceAlertKind, string>

type EditorField = "instrument" | "direction" | "kind" | "value" | "basis" | "interval" | "repeat" | "action"

export interface AlertEditorOptions {
  instruments: ViopInstrument[]
  // Present when editing; absent creates an alert on the selected instrument.
  alert?: PriceAlert
  // The instrument to start on when creating, so the alerts tab opens on
  // whatever the watchlist is pointing at.
  instrumentUid?: string
  lastPrice: (symbol: string) => number | null
  // Resolves the ATR the offset kinds measure with, or null when unavailable.
  atr?: (instrumentUid: string, interval: CandleInterval) => Promise<number | null>
  onSave: (draft: PriceAlertDraft) => void
  onClose: () => void
  onError?: (cause: unknown) => void
}

export class AlertEditor {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private instrumentIndex = 0
  private direction: LevelDirection = "ABOVE"
  private kind: PriceAlertKind = "PRICE"
  private basis: PriceAlertBasis = "TOUCH"
  private interval: CandleInterval = DEFAULT_ALERT_INTERVAL
  private repeat: PriceAlertRepeat = "ONCE"
  private valueText = ""
  private valueFresh = true
  private field: EditorField = "value"
  private atrValue: number | null = null
  private atrRequest = 0
  private status: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AlertEditorOptions,
  ) {
    const alert = options.alert
    if (alert) {
      this.instrumentIndex = Math.max(
        0,
        options.instruments.findIndex((instrument) => instrument.uid === alert.instrumentUid),
      )
      this.direction = alert.direction
      this.kind = alert.kind
      this.basis = alert.basis
      this.interval = alert.interval ?? DEFAULT_ALERT_INTERVAL
      this.repeat = alert.repeat
      this.valueText = String(alert.value)
      this.atrValue = alert.atrValue
      this.valueFresh = false
    } else if (options.instrumentUid) {
      this.instrumentIndex = Math.max(
        0,
        options.instruments.findIndex((instrument) => instrument.uid === options.instrumentUid),
      )
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
      borderColor: this.directionColor(),
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
      this.editValue((text) => text.slice(0, -1))
      return true
    }
    if (isDigitKey(key)) {
      this.editValue((text) => text + (key.sequence || key.name))
      return true
    }
    if (this.field === "value" && (key.sequence === "." || key.sequence === "," || key.name === "." || key.name === ",")) {
      this.editValue((text) => (text.includes(".") ? text : `${text}.`))
      return true
    }
    return true
  }

  private get instrument(): ViopInstrument | undefined {
    return this.options.instruments[this.instrumentIndex]
  }

  /** The draft as it currently stands; the single source for preview and save. */
  private draft(): PriceAlertDraft | null {
    const instrument = this.instrument
    if (!instrument) return null
    return {
      id: this.options.alert?.id,
      instrumentUid: instrument.uid,
      symbol: instrument.symbol,
      displayName: instrument.displayName,
      direction: this.direction,
      kind: this.kind,
      value: Number(this.valueText),
      basis: this.basis,
      interval: this.needsInterval() ? this.interval : null,
      repeat: this.repeat,
      referencePrice: this.options.lastPrice(instrument.symbol) ?? instrument.lastPrice,
      atrValue: isAtrAlert(this.kind) ? this.atrValue : null,
    }
  }

  private needsInterval(): boolean {
    return this.basis === "CLOSE" || isAtrAlert(this.kind)
  }

  private fields(): EditorField[] {
    const fields: EditorField[] = ["instrument", "direction", "kind", "value", "basis"]
    if (this.needsInterval()) fields.push("interval")
    fields.push("repeat", "action")
    return fields
  }

  private moveField(direction: number): void {
    const fields = this.fields()
    const index = fields.indexOf(this.field)
    this.field = fields[(Math.max(0, index) + direction + fields.length) % fields.length] ?? "value"
    this.render()
  }

  private cycleField(step: number): void {
    if (this.field === "instrument") {
      const count = this.options.instruments.length
      if (count > 0) this.instrumentIndex = (this.instrumentIndex + step + count) % count
      void this.refreshAtr()
    } else if (this.field === "direction") {
      this.direction = cycle(LEVEL_DIRECTIONS, this.direction, step)
      this.modal.borderColor = this.directionColor()
    } else if (this.field === "kind") {
      this.kind = cycle(ALERT_KINDS, this.kind, step)
      // Percent and ATR are different units; a value typed for one is wrong for
      // the other, so it starts fresh.
      this.valueText = ""
      this.valueFresh = true
      void this.refreshAtr()
    } else if (this.field === "basis") {
      this.basis = cycle(ALERT_BASES, this.basis, step)
      void this.refreshAtr()
    } else if (this.field === "interval") {
      this.interval = cycle(ALERT_INTERVALS, this.interval, step)
      void this.refreshAtr()
    } else if (this.field === "repeat") {
      this.repeat = cycle(ALERT_REPEATS, this.repeat, step)
    } else return
    this.status = null
    this.render()
  }

  private editValue(edit: (text: string) => string): void {
    if (this.field !== "value") return
    if (this.valueFresh) this.valueText = ""
    this.valueFresh = false
    this.valueText = edit(this.valueText)
    this.status = null
    this.render()
  }

  /** Reads the ATR the offset kinds measure with; only ATR alerts need it. */
  private async refreshAtr(): Promise<void> {
    const instrument = this.instrument
    const read = this.options.atr
    if (!read || !instrument || !isAtrAlert(this.kind)) return
    const request = ++this.atrRequest
    try {
      const atr = await read(instrument.uid, this.interval)
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
      this.fail("No contract to watch")
      return
    }
    const problem = validatePriceAlert(draft, this.options.lastPrice(draft.symbol))
    if (problem) {
      this.fail(problem)
      return
    }
    this.options.onSave(draft)
  }

  private fail(message: string): void {
    this.status = message
    this.render()
  }

  private directionColor(): string {
    return this.direction === "ABOVE" ? ABOVE_COLOR : BELOW_COLOR
  }

  private resizeModal(): void {
    this.modal.width = Math.min(76, Math.max(40, this.root.width - 2))
    this.modal.height = Math.min(24, Math.max(12, this.root.height - 2))
  }

  private render(): void {
    if (this.destroyed) return
    const draft = this.draft()
    const instrument = this.instrument
    const lastPrice = draft ? this.options.lastPrice(draft.symbol) : null
    const level = draft ? previewLevel(draft) : null
    const color = this.directionColor()

    const chunks: TextChunk[] = [
      fg(color)(this.options.alert ? "Edit price alert" : "New price alert"),
      fg(MUTED_COLOR)("  ·  the app watches and tells you; it never trades"),
      fg(VALUE_COLOR)("\n\n"),
      ...fieldLine(
        "Contract",
        instrument ? `${instrument.displayName}  ${instrument.symbol}` : "No contracts",
        this.field === "instrument",
      ),
      fg(VALUE_COLOR)("\n"),
      ...fieldLine(
        "Tell me when",
        this.direction === "ABOVE" ? "Price rises to the level" : "Price falls to the level",
        this.field === "direction",
      ),
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
      chunks.push(
        ...fieldLine("Timeframe", CANDLE_INTERVAL_LABELS[this.interval], this.field === "interval"),
        fg(VALUE_COLOR)("\n"),
      )
    }
    chunks.push(
      ...fieldLine(
        "Tell me",
        this.repeat === "ONCE" ? "Once, then stop" : "Every time it crosses",
        this.field === "repeat",
      ),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Market", formatNumber(lastPrice)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Level", level === null ? "—" : `${formatNumber(level)}${distanceLabel(level, lastPrice)}`),
      fg(VALUE_COLOR)("\n"),
    )
    if (isAtrAlert(this.kind)) {
      chunks.push(
        ...metricLine("ATR", this.atrValue === null ? "unavailable" : formatNumber(this.atrValue)),
        fg(VALUE_COLOR)("\n"),
      )
    }
    chunks.push(
      fg(VALUE_COLOR)("\n"),
      ...fieldLine("Save alert", this.field === "action" ? "Press Enter" : "Enter", this.field === "action"),
    )
    if (this.status) chunks.push(fg(ERROR_COLOR)(`\n\n${this.status}`))
    chunks.push(fg(MUTED_COLOR)("\n\nTab/↑/↓ field · ←/→ change · digits value · Enter save · Esc close"))
    this.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }
}

/** The level a draft resolves to, for the preview line. */
function previewLevel(draft: PriceAlertDraft): number | null {
  if (!Number.isFinite(draft.value) || draft.value <= 0) return null
  if (draft.kind === "PRICE") return draft.value
  const anchor = draft.referencePrice
  if (anchor === null || anchor <= 0) return null
  const distance = isAtrAlert(draft.kind) ? (draft.atrValue ?? 0) * draft.value : anchor * (draft.value / 100)
  if (distance <= 0) return null
  const level = draft.direction === "BELOW" ? anchor - distance : anchor + distance
  return level > 0 ? level : null
}
