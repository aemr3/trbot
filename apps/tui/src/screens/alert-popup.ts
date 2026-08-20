import { TUI_THEME } from "../theme.ts"
// What a fired price alert looks like. It states which level was reached and
// at what price, and then waits: there is no countdown and nothing to submit,
// because an alert has never had anything to do with sending an order.
import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import type { AlertTriggerEvent } from "@trbot/market/alert-monitor.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"

const PANEL_BG = TUI_THEME.appBackground
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const ALERT_COLOR = TUI_THEME.warning
const ABOVE_COLOR = TUI_THEME.positive
const BELOW_COLOR = TUI_THEME.negative

export interface AlertPopupOptions {
  event: AlertTriggerEvent
  // Dismiss leaves the alert fired; re-arm puts it back to watching the same
  // level, for a trader who wants to hear about the next crossing too.
  onDismiss: () => void
  onRearm: () => void
}

export class AlertPopup {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private lastPrice: number | null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AlertPopupOptions,
  ) {
    this.lastPrice = options.event.price

    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      onSizeChange: () => this.resizeModal(),
      // A click closes it for the same reason any key does. The root covers the
      // screen and mouse events bubble up to it, so this catches a click on the
      // popup itself as well as one beside it.
      onMouseDown: (event) => {
        if (this.destroyed || event.button !== 0) return
        event.stopPropagation()
        this.options.onDismiss()
      },
    })
    this.modal = new BoxRenderable(renderer, {
      width: 66,
      height: 15,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: options.event.alert.direction === "ABOVE" ? ABOVE_COLOR : BELOW_COLOR,
      flexDirection: "column",
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", flexGrow: 1, wrapMode: "word" })
    this.modal.add(this.content)
    this.root.add(this.modal)
    this.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  /** Keeps the price line honest while the popup stands open. */
  applyQuote(update: QuoteUpdate): void {
    if (this.destroyed || update.symbol !== this.options.event.alert.symbol || update.lastPrice === null) return
    this.lastPrice = update.lastPrice
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed) return true
    // A repeating alert re-armed itself the moment it fired, so there is
    // nothing for r to do.
    if (!key.ctrl && key.name === "r" && this.options.event.alert.repeat === "ONCE") {
      this.options.onRearm()
      return true
    }
    // Anything else closes it: an alert popup must never be the thing standing
    // between the trader and the keyboard.
    this.options.onDismiss()
    return true
  }

  private resizeModal(): void {
    this.modal.width = Math.min(66, Math.max(40, this.root.width - 2))
    this.modal.height = Math.min(15, Math.max(10, this.root.height - 2))
  }

  private render(): void {
    if (this.destroyed) return
    const { alert, price, priceAgeMs } = this.options.event
    const color = alert.direction === "ABOVE" ? ABOVE_COLOR : BELOW_COLOR
    const chunks: TextChunk[] = [
      fg(color)(`${alert.displayName} ${alert.direction === "ABOVE" ? "rose to" : "fell to"} ${formatNumber(price)}`),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Alert", `${alert.symbol}  ${alert.direction === "ABOVE" ? "above" : "below"} ${formatNumber(alert.triggerPrice)}`),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Reached on", alert.basis === "CLOSE" ? "a candle close" : "a trade"),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Market now", `${formatNumber(this.lastPrice)}${priceAgeLabel(priceAgeMs)}`),
      fg(VALUE_COLOR)("\n\n"),
      fg(ALERT_COLOR)("Nothing was traded. This is only a notice."),
      fg(MUTED_COLOR)(
        alert.repeat === "ALWAYS"
          ? "\n\nStill armed for the next crossing · any key or click dismisses"
          : "\n\nAny key or click dismisses · r re-arms the same level",
      ),
    ]
    this.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }
}

function priceAgeLabel(ageMs: number): string {
  if (ageMs < 2_000) return ""
  return `  (${Math.round(ageMs / 1000)}s old)`
}

function metricLine(label: string, value: string): TextChunk[] {
  return [fg(MUTED_COLOR)(label.padEnd(14)), fg(VALUE_COLOR)(`  ${value}`)]
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
