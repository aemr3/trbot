import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
  type StyledText,
} from "@opentui/core"

export const DOUBLE_CLICK_MS = 400

export interface SelectableListRow {
  id: string
  content: string | StyledText
  color?: string
}

export interface SelectableListOptions {
  onSelect?: (index: number) => void
  onActivate?: (index: number) => void
  onFocusRequest?: () => void
  selectedBackgroundColor?: string
  backgroundColor?: string
  indicatorColor?: string
  wrapContent?: boolean
  rowGap?: number
}

export interface SelectableListSetRowsOptions {
  preserveScroll?: boolean
}

// A keyboard-navigable, scrolling list where each row is painted in its own
// color (SelectRenderable only supports one shared color across all rows).
export class SelectableList {
  readonly root: ScrollBoxRenderable

  private rowBoxes: BoxRenderable[] = []
  private indicators: TextRenderable[] = []
  private contents: TextRenderable[] = []
  private selected = -1
  private lastClickIndex = -1
  private lastClickAt = 0

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: SelectableListOptions = {},
  ) {
    this.root = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: options.backgroundColor,
      contentOptions: { flexDirection: "column", gap: options.rowGap, paddingRight: 2, backgroundColor: options.backgroundColor },
    })
  }

  get selectedIndex(): number {
    return this.selected
  }

  selectIndex(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.rowBoxes.length) return false
    this.select(index)
    return true
  }

  /**
   * Replaces the rows.
   *
   * `selectedId` names the row to select, for a caller that owns the selection itself
   * and re-asserts it on every paint. Without it, a repaint — the same number of rows —
   * keeps the cursor where it is, and a list of a different shape starts at the top.
   * A caller that lets the list own the cursor must pass nothing: naming a row on every
   * repaint drags the cursor back to it on every keypress.
   */
  setRows(rows: SelectableListRow[], selectedId?: string, options: SelectableListSetRowsOptions = {}): void {
    if (rows.length > 0 && rows.length === this.rowBoxes.length) {
      const previous = this.selected
      rows.forEach((row, index) => {
        this.contents[index]!.content = row.content
        this.contents[index]!.fg = row.color
      })
      this.selected = this.resolveSelection(rows, selectedId, previous)
      this.paint(previous)
      if (!options.preserveScroll) {
        if (selectedId) this.root.scrollChildIntoView(`row-${this.selected}`)
      } else if (this.selected !== previous && !this.rowVisible(this.selected)) {
        // A reorder moved the selected row out of the window. Manual scroll is worth
        // preserving, but not at the price of the cursor disappearing: a watchlist
        // sorted by change reorders on every tick, and an absolute scroll offset would
        // leave the trader watching rows with no idea which stock is selected.
        this.root.scrollChildIntoView(`row-${this.selected}`)
      }
      return
    }

    const scrollTop = this.root.scrollTop
    for (const child of this.root.getChildren()) {
      this.root.remove(child)
      if (!child.isDestroyed) child.destroyRecursively()
    }
    this.rowBoxes = []
    this.indicators = []
    this.contents = []

    rows.forEach((row, index) => {
      const rowBox = new BoxRenderable(this.renderer, {
        id: `row-${index}`,
        flexDirection: "row",
        width: "100%",
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.select(index)
          const now = Date.now()
          const isDoubleClick = index === this.lastClickIndex && now - this.lastClickAt < DOUBLE_CLICK_MS
          this.lastClickIndex = index
          this.lastClickAt = isDoubleClick ? 0 : now
          if (isDoubleClick) this.options.onActivate?.(index)
        },
      })
      const indicator = new TextRenderable(this.renderer, {
        content: "  ",
        fg: this.options.indicatorColor ?? TUI_THEME.positive,
        width: 2,
        flexShrink: 0,
        wrapMode: "none",
      })
      const content = new TextRenderable(this.renderer, {
        content: row.content,
        fg: row.color,
        flexGrow: 1,
        wrapMode: this.options.wrapContent ? "word" : "none",
      })
      rowBox.add(indicator)
      rowBox.add(content)
      this.root.add(rowBox)
      this.rowBoxes.push(rowBox)
      this.indicators.push(indicator)
      this.contents.push(content)
    })

    this.selected = rows.length > 0 ? this.resolveSelection(rows, selectedId, -1) : -1
    this.paint(-1)
    if (options.preserveScroll) this.root.scrollTop = scrollTop
    else if (selectedId && this.selected >= 0) this.root.scrollChildIntoView(`row-${this.selected}`)
  }

  // Repaints one row's content in place, preserving selection and scroll — used
  // for live price ticks that must not rebuild or reorder the list.
  updateRow(index: number, update: { content?: string | StyledText; color?: string }): void {
    const content = this.contents[index]
    if (!content) return
    if (update.content !== undefined) content.content = update.content
    if (update.color !== undefined) content.fg = update.color
  }

  handleKey(key: KeyEvent): boolean {
    if (this.rowBoxes.length === 0) return false
    switch (key.name) {
      case "up":
      case "k":
        this.select((this.selected - 1 + this.rowBoxes.length) % this.rowBoxes.length)
        return true
      case "down":
      case "j":
        this.select((this.selected + 1) % this.rowBoxes.length)
        return true
      case "home":
        this.select(0)
        return true
      case "end":
        this.select(this.rowBoxes.length - 1)
        return true
      case "return":
      case "enter":
        if (this.selected >= 0) this.options.onActivate?.(this.selected)
        return true
      default:
        return false
    }
  }

  destroy(): void {
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  /** Whether a row sits inside the visible window, by the last layout's geometry. */
  private rowVisible(index: number): boolean {
    const row = this.rowBoxes[index]
    if (!row) return false
    const viewport = this.root.viewport
    return row.y >= viewport.y && row.y + row.height <= viewport.y + viewport.height
  }

  /** Which row a fresh set of rows leaves selected. `previous` is -1 when rebuilding. */
  private resolveSelection(rows: SelectableListRow[], selectedId: string | undefined, previous: number): number {
    if (selectedId !== undefined) {
      const named = rows.findIndex((row) => row.id === selectedId)
      return named >= 0 ? named : 0
    }
    return previous >= 0 && previous < rows.length ? previous : 0
  }

  private select(index: number): void {
    if (index === this.selected) return
    const previous = this.selected
    this.selected = index
    this.paint(previous)
    this.root.scrollChildIntoView(`row-${index}`)
    this.options.onSelect?.(index)
  }

  private paint(previous: number): void {
    const prevBox = this.rowBoxes[previous]
    if (prevBox) {
      prevBox.backgroundColor = this.options.backgroundColor
      this.indicators[previous]!.content = "  "
    }
    const currentBox = this.rowBoxes[this.selected]
    if (currentBox) {
      currentBox.backgroundColor = this.options.selectedBackgroundColor ?? TUI_THEME.defaultSelection
      this.indicators[this.selected]!.content = "▶ "
    }
  }
}
