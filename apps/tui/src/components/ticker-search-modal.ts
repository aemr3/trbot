import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type Renderable,
} from "@opentui/core"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const EMPHASIS_COLOR = TUI_THEME.accent
const SELECTED_BG = TUI_THEME.overlaySelection

export interface TickerSearchModalOptions {
  instruments: ViopInstrument[]
  currentUid: string | null
  onSelect: (instrument: ViopInstrument) => void
  onClose: () => void
}

/** Searches the contract universe without taking over the trade screen's footer. */
export class TickerSearchModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly search: InputRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable
  private highlightedUid: string | null
  private previousFocus: Renderable | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: TickerSearchModalOptions,
  ) {
    this.highlightedUid = options.instruments.some((instrument) => instrument.uid === options.currentUid)
      ? options.currentUid
      : options.instruments[0]?.uid ?? null

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
      width: 72,
      height: 22,
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
    this.header = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.search = new InputRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      marginBottom: 1,
      maxLength: 100,
      placeholder: "Search ticker or contract symbol…",
      backgroundColor: TUI_THEME.fieldBackground,
      focusedBackgroundColor: TUI_THEME.fieldBackground,
      textColor: VALUE_COLOR,
      focusedTextColor: VALUE_COLOR,
      cursorColor: EMPHASIS_COLOR,
    })
    this.search.on(InputRenderableEvents.INPUT, () => this.render(false))
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      onSelect: (index) => {
        this.highlightedUid = this.visibleInstruments()[index]?.uid ?? null
        this.render()
      },
      onActivate: () => this.selectHighlighted(),
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.search)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    this.previousFocus = this.renderer.currentFocusedRenderable
    this.search.focus()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.selectHighlighted()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      this.list.handleKey(key)
      return true
    }
    if (this.search.handleKeyPress(key)) return true
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
    const previousFocus = this.previousFocus
    this.previousFocus = null
    if (previousFocus && !previousFocus.isDestroyed) previousFocus.focus()
  }

  private selectHighlighted(): void {
    const visible = this.visibleInstruments()
    const instrument = visible.find((candidate) => candidate.uid === this.highlightedUid)
      ?? visible[this.list.selectedIndex]
    if (instrument) this.options.onSelect(instrument)
  }

  private render(preserveScroll = true): void {
    if (this.destroyed) return
    const visible = this.visibleInstruments()
    const matching = this.search.value ? `${visible.length} matching · ` : ""
    this.header.content = new StyledText([
      fg(VALUE_COLOR)("Ticker search\n"),
      fg(MUTED_COLOR)(`${matching}${this.options.instruments.length} contracts\n`),
    ])
    this.list.setRows(
      visible.map((instrument) => ({
        id: instrument.uid,
        content: new StyledText([
          fg(VALUE_COLOR)(instrument.displayName),
          fg(MUTED_COLOR)(`  ${instrument.symbol}`),
        ]),
      })),
      this.highlightedUid ?? undefined,
      { preserveScroll },
    )
    this.highlightedUid = visible[this.list.selectedIndex]?.uid ?? null
    this.footer.content = new StyledText([
      fg(MUTED_COLOR)(visible.length === 0
        ? "\nNo matching tickers.\nEsc close"
        : "\nType to search · Enter switch · ↑↓ ticker · Esc close"),
    ])
    this.renderer.requestRender()
  }

  private visibleInstruments(): ViopInstrument[] {
    const query = normalizedSearch(this.search.value)
    if (!query) return this.options.instruments
    return this.options.instruments
      .map((instrument, index) => ({ instrument, index, score: searchScore(instrument, query) }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.index - right.index)
      .map((entry) => entry.instrument)
  }

  private resizeModal(): void {
    this.modal.width = Math.max(42, Math.min(72, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(22, this.root.height - 2))
  }
}

function normalizedSearch(value: string): string {
  return value.trim().toUpperCase()
}

function searchScore(instrument: ViopInstrument, query: string): number | null {
  const values = [instrument.displayName, instrument.underlyingSymbol, instrument.symbol]
    .filter((value): value is string => Boolean(value))
    .map(normalizedSearch)
  if (values.some((value) => value === query || value === `F_${query}`)) return 0
  if (values.some((value) => value.startsWith(query) || value.startsWith(`F_${query}`))) return 1
  return values.some((value) => value.includes(query)) ? 2 : null
}
