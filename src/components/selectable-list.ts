import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"

export interface SelectableListRow {
  id: string
  content: string
  color?: string
}

export interface SelectableListOptions {
  onSelect?: (index: number) => void
  selectedBackgroundColor?: string
  backgroundColor?: string
  indicatorColor?: string
}

// A keyboard-navigable, scrolling list where each row is painted in its own
// color (SelectRenderable only supports one shared color across all rows).
export class SelectableList {
  readonly root: ScrollBoxRenderable

  private rowBoxes: BoxRenderable[] = []
  private indicators: TextRenderable[] = []
  private selected = -1

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: SelectableListOptions = {},
  ) {
    this.root = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: options.backgroundColor,
      contentOptions: { flexDirection: "column", backgroundColor: options.backgroundColor },
    })
  }

  get selectedIndex(): number {
    return this.selected
  }

  setRows(rows: SelectableListRow[]): void {
    for (const child of this.root.getChildren()) this.root.remove(child)
    this.rowBoxes = []
    this.indicators = []

    rows.forEach((row, index) => {
      const rowBox = new BoxRenderable(this.renderer, {
        id: `row-${index}`,
        flexDirection: "row",
        width: "100%",
        onMouseDown: (event) => {
          if (event.button === 0) this.select(index)
        },
      })
      const indicator = new TextRenderable(this.renderer, {
        content: "  ",
        fg: this.options.indicatorColor ?? "#70d7a1",
      })
      rowBox.add(indicator)
      rowBox.add(new TextRenderable(this.renderer, { content: row.content, fg: row.color }))
      this.root.add(rowBox)
      this.rowBoxes.push(rowBox)
      this.indicators.push(indicator)
    })

    this.selected = rows.length > 0 ? 0 : -1
    this.paint(-1)
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
      default:
        return false
    }
  }

  destroy(): void {
    if (!this.root.isDestroyed) this.root.destroyRecursively()
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
      currentBox.backgroundColor = this.options.selectedBackgroundColor ?? "#243b2f"
      this.indicators[this.selected]!.content = "▶ "
    }
  }
}
