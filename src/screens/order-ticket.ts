import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import type { ViopInstrument } from "../market/instrument.ts"
import {
  resolveViopOrderPrice,
  viopAffordableContracts,
  viopOrderSize,
  viopRequiredCollateral,
  type PlacedViopOrder,
  type ViopOrderKind,
  type ViopOrderPreparation,
  type ViopOrderSide,
  type ViopOrderSource,
} from "../trading/order.ts"

const PANEL_BG = "#101010"
const FIELD_BG = "#2b2b2b"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c83ff"
const BUY_COLOR = "#70d7a1"
const SELL_COLOR = "#ff6b6b"
const ERROR_COLOR = "#ff806f"

type TicketPhase = "edit" | "review" | "submitting" | "success"
type TicketField = "kind" | "price" | "quantity" | "action"

export interface ViopOrderTicketOptions {
  source: ViopOrderSource
  instrument: ViopInstrument
  side: ViopOrderSide
  initialKind?: ViopOrderKind
  onClose: () => void
  onKindChange?: (kind: ViopOrderKind) => void
  onPlaced?: (order: PlacedViopOrder) => void
  onError?: (error: unknown) => void
}

export interface TicketQuoteUpdate {
  lastPrice?: number | null
  ask?: number | null
  bid?: number | null
}

export class ViopOrderTicket {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private preparation: ViopOrderPreparation | null = null
  private kind: ViopOrderKind = "LIMIT"
  private phase: TicketPhase = "edit"
  private field: TicketField = "quantity"
  private limitPriceText: string
  private quantityText = "1"
  private priceFresh = true
  private quantityFresh = true
  private status: string | null = "Preparing order…"
  private statusColor = MUTED_COLOR
  private request: AbortController | null = null
  private placedOrder: PlacedViopOrder | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ViopOrderTicketOptions,
  ) {
    this.kind = options.initialKind ?? "LIMIT"
    this.limitPriceText = inputPrice(options.instrument.lastPrice, 2)
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
      height: 26,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: options.side === "BUY" ? BUY_COLOR : SELL_COLOR,
      flexDirection: "column",
    })
    this.content = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
    })
    this.modal.add(this.content)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    void this.prepare()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.request?.abort()
    this.request = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  applyQuote(update: TicketQuoteUpdate): void {
    const preparation = this.preparation
    if (!preparation) return
    if (update.lastPrice !== undefined) preparation.lastPrice = update.lastPrice
    if (update.ask !== undefined) preparation.ask = update.ask
    if (update.bid !== undefined) preparation.bid = update.bid
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.phase === "submitting") return true
    if (key.name === "escape" || key.name === "esc") {
      if (this.phase === "review") {
        this.phase = "edit"
        this.status = null
        this.render()
      } else this.options.onClose()
      return true
    }
    if (this.phase === "success") {
      if (key.name === "return" || key.name === "enter") this.options.onClose()
      return true
    }
    if (this.phase === "review") {
      if (key.name === "return" || key.name === "enter" || this.isSideShortcut(key)) void this.submit()
      return true
    }

    if (this.isSideShortcut(key)) {
      this.review()
      return true
    }

    if (!key.ctrl && key.name === "m") {
      this.selectKind("MARKETABLE_LIMIT")
      return true
    }
    if (!key.ctrl && key.name === "l") {
      this.selectKind("LIMIT")
      return true
    }
    if (!key.ctrl && key.name === "r") {
      this.review()
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
    if (this.field === "kind" && (key.name === "left" || key.name === "right" || key.name === "space")) {
      this.selectKind(this.kind === "LIMIT" ? "MARKETABLE_LIMIT" : "LIMIT")
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.field === "action") this.review()
      else this.moveField(1)
      return true
    }
    if (key.name === "backspace") {
      this.backspaceField()
      return true
    }
    if (isDigitKey(key)) {
      this.appendToField(key.sequence || key.name)
      return true
    }
    if (this.field === "price" && (key.name === "." || key.name === "," || key.sequence === "." || key.sequence === ",")) {
      this.appendToField(".")
      return true
    }
    return true
  }

  private async prepare(): Promise<void> {
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    try {
      const preparation = await this.options.source.prepareOrder({
        instrumentUid: this.options.instrument.uid,
        side: this.options.side,
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.preparation = preparation
      if (this.priceFresh) {
        const initialPrice = this.options.instrument.lastPrice ?? preparation.lastPrice
        this.limitPriceText = inputPrice(initialPrice, preparation.priceScale)
      }
      this.status = null
      this.render()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) return
      this.status = errorMessage(error)
      this.statusColor = ERROR_COLOR
      this.options.onError?.(error)
      if (!this.destroyed) this.render()
    }
  }

  private selectKind(kind: ViopOrderKind): void {
    const changed = this.kind !== kind
    this.kind = kind
    if (kind === "MARKETABLE_LIMIT" && this.field === "price") this.field = "quantity"
    this.status = null
    if (changed) this.options.onKindChange?.(kind)
    this.render()
  }

  private moveField(direction: number): void {
    const fields: TicketField[] = this.kind === "LIMIT"
      ? ["kind", "price", "quantity", "action"]
      : ["kind", "quantity", "action"]
    const index = fields.indexOf(this.field)
    this.field = fields[(Math.max(0, index) + direction + fields.length) % fields.length] ?? "kind"
    this.render()
  }

  private appendToField(character: string): void {
    if (this.field === "price" && this.kind === "LIMIT") {
      if (this.priceFresh) this.limitPriceText = ""
      this.priceFresh = false
      if (character === "." && this.limitPriceText.includes(".")) return
      this.limitPriceText += character
    } else if (this.field === "quantity" && character !== ".") {
      if (this.quantityFresh) this.quantityText = ""
      this.quantityFresh = false
      this.quantityText += character
    } else return
    this.status = null
    this.render()
  }

  private backspaceField(): void {
    if (this.field === "price" && this.kind === "LIMIT") {
      this.priceFresh = false
      this.limitPriceText = this.limitPriceText.slice(0, -1)
    } else if (this.field === "quantity") {
      this.quantityFresh = false
      this.quantityText = this.quantityText.slice(0, -1)
    } else return
    this.status = null
    this.render()
  }

  private review(): void {
    const error = this.validationError()
    if (error) {
      this.status = error
      this.statusColor = ERROR_COLOR
      this.render()
      return
    }
    this.phase = "review"
    this.status = null
    this.render()
  }

  private async submit(): Promise<void> {
    const preparation = this.preparation
    const price = this.resolvedPrice()
    const quantity = this.quantity()
    if (!preparation || price === null || quantity === null) return
    this.phase = "submitting"
    this.status = "Submitting order…"
    this.statusColor = MUTED_COLOR
    this.render()
    const request = new AbortController()
    this.request = request
    try {
      const order = await this.options.source.placeOrder({
        instrumentUid: this.options.instrument.uid,
        side: this.options.side,
        quantity,
        limitPrice: price,
        signal: request.signal,
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.placedOrder = order
      this.phase = "success"
      this.status = null
      this.options.onPlaced?.(order)
      this.render()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) return
      this.phase = "review"
      this.status = errorMessage(error)
      this.statusColor = ERROR_COLOR
      this.options.onError?.(error)
      if (!this.destroyed) this.render()
    }
  }

  private validationError(): string | null {
    const preparation = this.preparation
    if (!preparation) return this.status ?? "Order preparation is still loading"
    const quantity = this.quantity()
    if (quantity === null) return "Enter a positive whole number of contracts"
    const price = this.resolvedPrice()
    if (price === null) {
      return this.kind === "MARKETABLE_LIMIT"
        ? "The exchange price limit is unavailable"
        : "Enter a valid limit price"
    }
    if (preparation.lowerLimit !== null && price < preparation.lowerLimit) return "Limit price is below the lower limit"
    if (preparation.upperLimit !== null && price > preparation.upperLimit) return "Limit price is above the upper limit"
    const required = viopRequiredCollateral(quantity, preparation.initialCollateral)
    if (required !== null && preparation.availableCollateral !== null && required > preparation.availableCollateral) {
      return "Available collateral is insufficient for this order"
    }
    return null
  }

  private quantity(): number | null {
    if (!/^\d+$/.test(this.quantityText)) return null
    const value = Number(this.quantityText)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  private enteredLimitPrice(): number | null {
    const value = Number(this.limitPriceText.replace(",", "."))
    return Number.isFinite(value) && value > 0 ? value : null
  }

  private resolvedPrice(): number | null {
    return resolveViopOrderPrice(this.kind, this.options.side, this.enteredLimitPrice(), this.preparation ?? {
      lowerLimit: null,
      upperLimit: null,
    })
  }

  private isSideShortcut(key: KeyEvent): boolean {
    return !key.ctrl && key.name === (this.options.side === "BUY" ? "b" : "s")
  }

  private resizeModal(): void {
    if (this.root.width <= 0 || this.root.height <= 0) return
    this.modal.width = Math.max(1, Math.min(76, this.root.width - 2))
    this.modal.height = Math.max(1, Math.min(26, this.root.height - 2))
  }

  private render(): void {
    this.content.content = this.phase === "edit"
      ? this.renderEdit()
      : this.phase === "success"
        ? this.renderSuccess()
        : this.renderReview()
  }

  private renderEdit(): StyledText {
    const preparation = this.preparation
    const quantity = this.quantity() ?? 0
    const price = this.resolvedPrice()
    const orderSize = viopOrderSize(price, quantity, preparation?.contractSize ?? null)
    const required = viopRequiredCollateral(quantity, preparation?.initialCollateral ?? null)
    const affordable = viopAffordableContracts(
      preparation?.availableCollateral ?? null,
      preparation?.initialCollateral ?? null,
    )
    const sideColor = this.options.side === "BUY" ? BUY_COLOR : SELL_COLOR
    const chunks: TextChunk[] = [
      fg(MUTED_COLOR)("Esc close"),
      fg(VALUE_COLOR)("\n\n"),
      fg(sideColor)(`${this.options.side === "BUY" ? "Buy" : "Sell"} ${contractLabel(this.options.instrument)}`),
      fg(MUTED_COLOR)("  ·  VIOP day order"),
      fg(VALUE_COLOR)("\n\n"),
      ...fieldLine("Order type", this.kind === "LIMIT" ? "Limit" : "Simulated market", this.field === "kind"),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Lower limit", formatMoney(preparation?.lowerLimit ?? null, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Upper limit", formatMoney(preparation?.upperLimit ?? null, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine(
        "Quote",
        `Ask ${formatMoney(preparation?.ask ?? null, this.options.instrument.currency)} · Bid ${formatMoney(preparation?.bid ?? null, this.options.instrument.currency)}`,
      ),
      fg(VALUE_COLOR)("\n\n"),
    ]
    if (this.kind === "LIMIT") {
      chunks.push(
        ...fieldLine(
          "Limit price",
          formatMoney(this.enteredLimitPrice(), this.options.instrument.currency),
          this.field === "price",
        ),
        fg(VALUE_COLOR)("\n"),
      )
    } else {
      chunks.push(...metricLine("Resolved limit", formatMoney(price, this.options.instrument.currency)), fg(VALUE_COLOR)("\n"))
    }
    chunks.push(
      ...fieldLine("Contracts", this.quantityText || "—", this.field === "quantity"),
      fg(affordable === null ? MUTED_COLOR : affordable > 0 ? BUY_COLOR : ERROR_COLOR)(
        `\n  ${affordable === null ? "Capacity unavailable" : `${affordable} contract${affordable === 1 ? "" : "s"} available by collateral`}`,
      ),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Order size", formatMoney(orderSize, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Required collateral", formatMoney(required, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Available collateral", formatMoney(preparation?.availableCollateral ?? null, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n\n"),
      ...fieldLine(
        "Review order",
        this.field === "action" ? `Press ${this.options.side === "BUY" ? "B" : "S"} or Enter` : this.options.side === "BUY" ? "B" : "S",
        this.field === "action",
      ),
    )
    if (this.status) chunks.push(fg(this.statusColor)(`\n\n${this.status}`))
    chunks.push(fg(MUTED_COLOR)(
      `\n\nTab/↑/↓ field · L limit · M simulated market · ${this.options.side === "BUY" ? "B buy" : "S sell"} · Esc close`,
    ))
    return new StyledText(chunks)
  }

  private renderReview(): StyledText {
    const preparation = this.preparation
    const price = this.resolvedPrice()
    const quantity = this.quantity() ?? 0
    const sideColor = this.options.side === "BUY" ? BUY_COLOR : SELL_COLOR
    const chunks: TextChunk[] = [
      fg(sideColor)(`Review ${this.options.side === "BUY" ? "buy" : "sell"} order`),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Contract", contractLabel(this.options.instrument)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Order type", this.kind === "LIMIT" ? "Limit" : "Simulated market (limit protected)"),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Limit price", formatMoney(price, this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Contracts", String(quantity)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Order size", formatMoney(viopOrderSize(price, quantity, preparation?.contractSize ?? null), this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Required collateral", formatMoney(viopRequiredCollateral(quantity, preparation?.initialCollateral ?? null), this.options.instrument.currency)),
      fg(VALUE_COLOR)("\n\n"),
    ]
    if (this.kind === "MARKETABLE_LIMIT") {
      chunks.push(fg(ERROR_COLOR)("Unfilled quantity may remain as a day limit order until session close."), fg(VALUE_COLOR)("\n\n"))
    }
    if (this.phase === "submitting") chunks.push(fg(EMPHASIS_COLOR)("Submitting order…"))
    else chunks.push(
      fg(sideColor)(`Enter or ${this.options.side === "BUY" ? "B" : "S"} to submit live order`),
      fg(MUTED_COLOR)(" · Esc to edit"),
    )
    if (this.status) chunks.push(fg(this.statusColor)(`\n\n${this.status}`))
    return new StyledText(chunks)
  }

  private renderSuccess(): StyledText {
    const order = this.placedOrder
    return new StyledText([
      fg(BUY_COLOR)("Order submitted"),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Order ID", order?.uid ?? "—"),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Status", order?.description ?? order?.status ?? "Pending"),
      fg(MUTED_COLOR)("\n\nEnter or Esc to return to the watchlist"),
    ])
  }
}

function fieldLine(label: string, value: string, active: boolean): TextChunk[] {
  return [
    fg(MUTED_COLOR)(label.padEnd(24)),
    fg(active ? EMPHASIS_COLOR : VALUE_COLOR)(active ? `▸ ${value} ` : `  ${value}`),
    ...(active ? [fg(FIELD_BG)(" ")] : []),
  ]
}

function metricLine(label: string, value: string): TextChunk[] {
  return [fg(MUTED_COLOR)(label.padEnd(24)), fg(VALUE_COLOR)(`  ${value}`)]
}

function contractLabel(instrument: ViopInstrument): string {
  const symbol = instrument.symbol.replace(/^F_/, "")
  const match = symbol.match(/^(.+?)(\d{2})(\d{2})$/)
  return match ? `${match[1]} ${match[2]}/${match[3]}` : instrument.displayName
}

function inputPrice(value: number | null, scale: number): string {
  return value === null || !Number.isFinite(value) ? "" : value.toFixed(scale)
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const amount = value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "TRY" ? `₺${amount}` : `${amount} ${currency}`
}

function isDigitKey(key: KeyEvent): boolean {
  return /^\d$/.test(key.sequence || key.name)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
