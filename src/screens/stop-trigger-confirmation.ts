// The last thing between a breached level and a live order. It states exactly
// what will be sent, counts down, and sends unless the trader stops it.
import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"
import type { QuoteUpdate } from "../market/quote-stream.ts"
import type { StopTriggerEvent } from "../trading/stop-monitor.ts"

const PANEL_BG = "#101010"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const ALERT_COLOR = "#e5c07b"
const STOP_COLOR = "#ff6b6b"
const TARGET_COLOR = "#70d7a1"

const DEFAULT_COUNTDOWN_MS = 10_000
const DEFAULT_TICK_MS = 250

export interface StopTriggerConfirmationOptions {
  event: StopTriggerEvent
  countdownMs?: number
  tickMs?: number
  onConfirm: () => void
  onCancel: () => void
}

export class StopTriggerConfirmation {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly content: TextRenderable
  private readonly countdownMs: number
  private remainingMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private held = false
  private submitting = false
  private lastPrice: number | null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: StopTriggerConfirmationOptions,
  ) {
    this.countdownMs = options.countdownMs ?? DEFAULT_COUNTDOWN_MS
    this.remainingMs = this.countdownMs
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
    })
    this.modal = new BoxRenderable(renderer, {
      width: 72,
      height: 20,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: options.event.rule.role === "STOP" ? STOP_COLOR : TARGET_COLOR,
      flexDirection: "column",
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", flexGrow: 1, wrapMode: "word" })
    this.modal.add(this.content)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    const tick = this.options.tickMs ?? DEFAULT_TICK_MS
    this.timer = setInterval(() => this.advance(tick), tick)
    // A zero countdown means "send now", which the tests lean on; the timer
    // above would otherwise wait a tick for it.
    if (this.countdownMs <= 0) this.advance(tick)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopCountdown()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  /** Keeps the price line honest while the trader decides. */
  applyQuote(update: QuoteUpdate): void {
    if (this.destroyed || update.symbol !== this.options.event.rule.symbol || update.lastPrice === null) return
    this.lastPrice = update.lastPrice
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.submitting) return true
    if (key.name === "escape" || key.name === "esc") {
      this.stopCountdown()
      this.options.onCancel()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.confirm()
      return true
    }
    // Holding stops the clock: the exit then needs an explicit Enter.
    if (!key.ctrl && key.name === "p") {
      this.held = !this.held
      this.render()
      return true
    }
    return true
  }

  private advance(tickMs: number): void {
    if (this.destroyed || this.submitting || this.held) return
    this.remainingMs = Math.max(0, this.remainingMs - tickMs)
    if (this.remainingMs > 0) {
      this.render()
      return
    }
    this.confirm()
  }

  private confirm(): void {
    if (this.submitting || this.destroyed) return
    this.submitting = true
    this.stopCountdown()
    this.render()
    this.options.onConfirm()
  }

  private stopCountdown(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private resizeModal(): void {
    this.modal.width = Math.min(72, Math.max(40, this.root.width - 2))
    this.modal.height = Math.min(20, Math.max(12, this.root.height - 2))
  }

  private render(): void {
    if (this.destroyed) return
    const { rule, position, price, quantity, side, priceAgeMs } = this.options.event
    const roleColor = rule.role === "STOP" ? STOP_COLOR : TARGET_COLOR
    const seconds = Math.ceil(this.remainingMs / 1000)
    const chunks: TextChunk[] = [
      fg(roleColor)(`${rule.role === "STOP" ? "Stop" : "Target"} reached · ${rule.displayName}`),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Position", `${formatQuantity(position.quantity)} contracts @ ${formatNumber(position.averageCost)}`),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Level", `${formatNumber(rule.triggerPrice)}  ${rule.basis === "CLOSE" ? "on a candle close" : "on a trade"}`),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Reached at", formatNumber(price)),
      fg(VALUE_COLOR)("\n"),
      ...metricLine("Market now", `${formatNumber(this.lastPrice)}${priceAgeLabel(priceAgeMs)}`),
      fg(VALUE_COLOR)("\n\n"),
      ...metricLine("Will send", `${side} ${quantity} at the exchange limit (marketable)`),
      fg(VALUE_COLOR)("\n\n"),
    ]

    if (this.submitting) {
      chunks.push(fg(ALERT_COLOR)("Submitting exit…"))
    } else if (this.held) {
      chunks.push(fg(ALERT_COLOR)("Countdown held · Enter sends, Esc cancels"))
    } else {
      chunks.push(
        fg(ALERT_COLOR)(`Sending in ${seconds}s  `),
        fg(roleColor)(countdownBar(this.remainingMs, this.countdownMs)),
      )
    }
    chunks.push(fg(MUTED_COLOR)("\n\nEnter send now · p hold · Esc cancel and stand the rule down"))
    this.content.content = new StyledText(chunks)
    this.renderer.requestRender()
  }
}

function countdownBar(remainingMs: number, totalMs: number): string {
  const width = 20
  const filled = totalMs <= 0 ? 0 : Math.round((remainingMs / totalMs) * width)
  return `${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, width - filled))}`
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

function formatQuantity(value: number): string {
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })
}
