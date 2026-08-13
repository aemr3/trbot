import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import {
  describeDates,
  describePreset,
  formatDay,
  isSameRange,
  type BrokerageDatePreset,
  type BrokerageDateRange,
} from "../market/brokerage.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const TITLE_COLOR = "#ffffff"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const ACCENT_COLOR = "#7c83ff"
const SELECTED_ROW_BG = "#282828"

const MODAL_WIDTH = 46
const MODAL_HEIGHT = 22
// What a row can actually use: the modal's border and padding, plus the list's
// own selection indicator, right padding, and scrollbar column.
const ROW_WIDTH = MODAL_WIDTH - 11

// Which list the modal is showing: the provider's own presets, or the day list
// used to build a single day or a custom range from it.
type Step = "presets" | "day" | "rangeFrom" | "rangeTo"

const SINGLE_DAY_ID = "pick-day"
const CUSTOM_RANGE_ID = "pick-range"

export interface BrokerageDateModalOptions {
  presets: BrokerageDatePreset[]
  availableDates: string[]
  range: BrokerageDateRange
  onSelect: (range: BrokerageDateRange) => void
  onClose: () => void
}

// Picks the date range behind the broker distribution. The provider offers a
// few named presets plus the full set of trading days it will report on, so the
// modal exposes both rather than only the presets.
export class BrokerageDateModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly title: TextRenderable
  private readonly hint: TextRenderable
  private readonly list: SelectableList
  private step: Step = "presets"
  private rangeFrom: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: BrokerageDateModalOptions,
  ) {
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
      width: MODAL_WIDTH,
      height: MODAL_HEIGHT,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: BORDER_COLOR,
      flexDirection: "column",
    })
    this.title = new TextRenderable(renderer, { content: "", fg: TITLE_COLOR, marginBottom: 1 })
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_ROW_BG,
      indicatorColor: TITLE_COLOR,
      onActivate: (index) => this.activate(index),
    })
    this.hint = new TextRenderable(renderer, { content: "", fg: MUTED_COLOR, marginTop: 1 })
    this.modal.add(this.title)
    this.modal.add(this.list.root)
    this.modal.add(this.hint)
    this.root.add(this.modal)
    this.showPresets()
  }

  handleKey(key: KeyEvent): void {
    if (this.destroyed) return
    if (key.name === "escape" || key.name === "esc") {
      // Escape backs out of the day list before it closes the modal.
      if (this.step === "presets") this.options.onClose()
      else this.showPresets()
      return
    }
    this.list.handleKey(key)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private showPresets(): void {
    this.step = "presets"
    this.rangeFrom = null
    this.title.content = "Broker distribution range"
    this.hint.content = "Enter select · Esc close"
    const rows = this.options.presets.map((preset, index) => ({
      id: `preset:${index}`,
      content: row(
        describePreset(preset),
        describeDates(preset.range),
        isSameRange(preset.range, this.options.range),
      ),
    }))
    rows.push({ id: SINGLE_DAY_ID, content: row("Single day…", `${this.options.availableDates.length} days`, false) })
    rows.push({ id: CUSTOM_RANGE_ID, content: row("Custom range…", "", false) })
    this.list.setRows(rows)
    this.renderer.requestRender()
  }

  private showDays(step: Extract<Step, "day" | "rangeFrom" | "rangeTo">): void {
    this.step = step
    this.title.content = step === "day"
      ? "Pick a day"
      : step === "rangeFrom"
        ? "Range · pick the first day"
        : `Range · pick the last day (from ${formatDay(this.rangeFrom ?? "")})`
    this.hint.content = "Enter select · Esc back"
    this.list.setRows(this.selectableDays(step).map((date) => ({
      id: `day:${date}`,
      content: row(formatDay(date), date, false),
    })))
    this.renderer.requestRender()
  }

  // A range's last day cannot precede its first, so the closing list is limited
  // to the days at or after the one already chosen.
  private selectableDays(step: Step): string[] {
    const dates = this.options.availableDates
    if (step !== "rangeTo" || !this.rangeFrom) return dates
    const from = this.rangeFrom
    return dates.filter((date) => date >= from)
  }

  private activate(index: number): void {
    if (this.step === "presets") {
      const preset = this.options.presets[index]
      if (preset) {
        this.options.onSelect(preset.range)
        return
      }
      const extra = index - this.options.presets.length
      if (extra === 0) this.showDays("day")
      else if (extra === 1) this.showDays("rangeFrom")
      return
    }

    const date = this.selectableDays(this.step)[index]
    if (!date) return
    if (this.step === "day") {
      this.options.onSelect({ start: date, end: null })
      return
    }
    if (this.step === "rangeFrom") {
      this.rangeFrom = date
      this.showDays("rangeTo")
      return
    }
    this.options.onSelect({ start: this.rangeFrom, end: date })
  }

  private resizeModal(): void {
    if (this.root.width <= 0 || this.root.height <= 0) return
    this.modal.width = Math.max(1, Math.min(MODAL_WIDTH, this.root.width - 2))
    this.modal.height = Math.max(1, Math.min(MODAL_HEIGHT, this.root.height - 2))
  }
}

function row(title: string, detail: string, active: boolean): StyledText {
  const spacing = Math.max(1, ROW_WIDTH - title.length - detail.length)
  return new StyledText([
    fg(active ? ACCENT_COLOR : TEXT_COLOR)(title),
    fg(MUTED_COLOR)(" ".repeat(spacing)),
    fg(MUTED_COLOR)(detail),
  ])
}
