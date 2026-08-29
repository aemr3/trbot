import { TUI_THEME } from "../theme.ts"
import {
  StyledText,
  fg,
  type BoxRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type { ViopInstrument } from "@trbot/market/instrument.ts"
import { ListModalFrame } from "./list-modal-frame.ts"

const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary

export interface TickerSearchModalOptions {
  instruments: ViopInstrument[]
  currentUid: string | null
  onSelect: (instrument: ViopInstrument) => void
  onClose: () => void
}

/** Searches the contract universe without taking over the trade screen's footer. */
export class TickerSearchModal {
  readonly root: BoxRenderable

  private readonly frame: ListModalFrame
  private highlightedUid: string | null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: TickerSearchModalOptions,
  ) {
    this.highlightedUid = options.instruments.some((instrument) => instrument.uid === options.currentUid)
      ? options.currentUid
      : options.instruments[0]?.uid ?? null

    this.frame = new ListModalFrame(renderer, {
      maxWidth: 72,
      maxHeight: 22,
      minWidth: 42,
      minHeight: 10,
      search: {
        placeholder: "Search ticker or contract symbol…",
        onInput: () => this.render(false),
      },
      onSelect: (index) => {
        this.highlightedUid = this.visibleInstruments()[index]?.uid ?? null
        this.render()
      },
      onActivate: () => this.selectHighlighted(),
    })
    this.root = this.frame.root
    this.render()
  }

  mount(): void {
    this.frame.mount()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    return this.frame.handleKey(key)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.frame.destroy()
  }

  private selectHighlighted(): void {
    const visible = this.visibleInstruments()
    const instrument = visible.find((candidate) => candidate.uid === this.highlightedUid)
      ?? visible[this.frame.list.selectedIndex]
    if (instrument) this.options.onSelect(instrument)
  }

  private render(preserveScroll = true): void {
    if (this.destroyed) return
    const visible = this.visibleInstruments()
    const matching = this.frame.searchValue ? `${visible.length} matching · ` : ""
    this.frame.header.content = new StyledText([
      fg(VALUE_COLOR)("Ticker search\n"),
      fg(MUTED_COLOR)(`${matching}${this.options.instruments.length} contracts\n`),
    ])
    this.frame.list.setRows(
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
    this.highlightedUid = visible[this.frame.list.selectedIndex]?.uid ?? null
    this.frame.footer.content = new StyledText([
      fg(MUTED_COLOR)(visible.length === 0
        ? "\nNo matching tickers.\nEsc close"
        : "\nType to search · Enter switch · ↑↓ ticker · Esc close"),
    ])
    this.renderer.requestRender()
  }

  private visibleInstruments(): ViopInstrument[] {
    const query = normalizedSearch(this.frame.searchValue)
    if (!query) return this.options.instruments
    return this.options.instruments
      .map((instrument, index) => ({ instrument, index, score: searchScore(instrument, query) }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.index - right.index)
      .map((entry) => entry.instrument)
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
