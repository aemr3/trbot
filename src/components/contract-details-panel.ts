import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { ViopContractDetails, ViopInstrument } from "../market/instrument.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const PANEL_BG = "#161616"
const HEADING_COLOR = "#eeeeee"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c8cff"
const ERROR_COLOR = "#ff6b6b"

type PanelStatus = "loading" | "ready" | "unavailable" | "error"

export class ContractDetailsPanel {
  readonly root: BoxRenderable

  private readonly content: TextRenderable
  private instrument: ViopInstrument | null = null
  private details: ViopContractDetails | null = null
  private status: PanelStatus = "unavailable"
  // Price ticks arrive in bursts; the latest one is re-rendered once per burst.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.root.isDestroyed) this.render()
  })

  constructor(renderer: RenderContext) {
    this.root = new BoxRenderable(renderer, {
      height: 13,
      flexShrink: 0,
      flexDirection: "column",
      border: ["top"],
      borderColor: "#303030",
      backgroundColor: PANEL_BG,
      onSizeChange: () => this.render(),
    })
    this.content = new TextRenderable(renderer, {
      content: "Select a VIOP contract.",
      fg: MUTED_COLOR,
      width: "100%",
      wrapMode: "none",
    })
    this.root.add(this.content)
  }

  selectInstrument(instrument: ViopInstrument, canLoadDetails: boolean): void {
    this.instrument = instrument
    this.details = null
    this.status = canLoadDetails ? "loading" : "unavailable"
    this.render()
  }

  showDetails(instrumentUid: string, details: ViopContractDetails): void {
    if (this.instrument?.uid !== instrumentUid) return
    this.details = details
    this.status = "ready"
    this.render()
  }

  showError(instrumentUid: string): void {
    if (this.instrument?.uid !== instrumentUid) return
    this.details = null
    this.status = "error"
    this.render()
  }

  applyPrice(symbol: string, lastPrice: number): void {
    if (this.instrument?.symbol !== symbol) return
    this.instrument.lastPrice = lastPrice
    if (this.status === "ready") this.liveRender.schedule()
  }

  private render(): void {
    const instrument = this.instrument
    if (!instrument) return
    if (this.status !== "ready" || !this.details) {
      const message =
        this.status === "loading"
          ? "Loading contract details…"
          : this.status === "error"
            ? "Contract details unavailable."
            : "Contract details are unavailable."
      this.content.content = new StyledText([
        fg(HEADING_COLOR)(`Contract · ${instrument.displayName}`),
        fg(MUTED_COLOR)("\n"),
        fg(this.status === "error" ? ERROR_COLOR : MUTED_COLOR)(message),
      ])
      return
    }

    const details = this.details
    const orderSize =
      instrument.lastPrice !== null && details.contractSize !== null
        ? instrument.lastPrice * details.contractSize
        : null
    const leverage =
      details.leverage ??
      (orderSize !== null && details.initialCollateral !== null && details.initialCollateral > 0
        ? orderSize / details.initialCollateral
        : null)
    const settlementLabel = this.root.width < 34 ? "Stl" : "Settle"
    const volumeLabel = this.root.width < 34 ? "V" : "Vol"
    const chunks: TextChunk[] = [
      fg(HEADING_COLOR)(`Contract · ${instrument.displayName}`),
      newline(),
      ...pair("Margin", formatMoney(details.initialCollateral, instrument.currency), "Lev", formatNumber(leverage)),
      newline(),
      ...pair("Size", formatQuantity(details.contractSize), "Exp", details.expiryDate ?? "—"),
      newline(),
      newline(),
      fg(HEADING_COLOR)("1 contract"),
      newline(),
      ...metric("Order size", formatMoney(orderSize, instrument.currency), EMPHASIS_COLOR),
      newline(),
      ...metric("Required", formatMoney(details.initialCollateral, instrument.currency), EMPHASIS_COLOR),
      newline(),
      newline(),
      fg(HEADING_COLOR)("Stats · "),
      ...pair("High", formatMoney(details.sessionHigh, instrument.currency), "Low", formatMoney(details.sessionLow, instrument.currency)),
      newline(),
      ...pair(settlementLabel, formatMoney(details.settlementPrice, instrument.currency), "Prev", formatMoney(details.previousSettlementPrice, instrument.currency)),
      newline(),
      ...pair(volumeLabel, formatQuantity(details.volume), "OI", formatQuantity(details.openInterest)),
    ]
    this.content.content = new StyledText(chunks)
  }
}

function pair(leftLabel: string, leftValue: string, rightLabel: string, rightValue: string): TextChunk[] {
  return [
    fg(MUTED_COLOR)(`${leftLabel} `),
    fg(VALUE_COLOR)(leftValue),
    fg(MUTED_COLOR)(` · ${rightLabel} `),
    fg(VALUE_COLOR)(rightValue),
  ]
}

function metric(label: string, value: string, valueColor = VALUE_COLOR): TextChunk[] {
  return [fg(MUTED_COLOR)(`${label.padEnd(11)} `), fg(valueColor)(value)]
}

function newline(): TextChunk {
  return fg(VALUE_COLOR)("\n")
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null) return "—"
  const amount = value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "TRY" ? `₺${amount}` : `${amount} ${currency}`
}

function formatNumber(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatQuantity(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })
}
