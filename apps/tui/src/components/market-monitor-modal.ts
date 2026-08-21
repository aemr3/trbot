import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { MarketMonitor } from "@trbot/market/market-monitor.ts"
import { isOpenPriceAlert } from "@trbot/market/alert.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const ABOVE_COLOR = TUI_THEME.positive
const BELOW_COLOR = TUI_THEME.negative
const ARMED_COLOR = TUI_THEME.positive
const TRIGGERED_COLOR = TUI_THEME.warning
const CONFIRM_COLOR = TUI_THEME.warning
const SELECTED_BG = TUI_THEME.overlaySelection

export interface MarketMonitorModalOptions {
  monitors: MarketMonitor[]
  onCancel: (monitorId: string) => void
  onClose: () => void
}

/** Session-owned market monitors created by the agent in the open chat. */
export class MarketMonitorModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable
  private monitors: MarketMonitor[]
  private highlighted: string | null
  private pendingCancel: string | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: MarketMonitorModalOptions,
  ) {
    this.monitors = order(options.monitors)
    this.highlighted = this.monitors[0]?.id ?? null

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
      width: 82,
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
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      onSelect: (index) => {
        this.highlighted = this.monitors[index]?.id ?? null
        this.pendingCancel = null
        this.render()
      },
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  setMonitors(monitors: MarketMonitor[]): void {
    if (this.destroyed) return
    this.monitors = order(monitors)
    if (!this.monitors.some((monitor) => monitor.id === this.highlighted)) {
      this.highlighted = this.monitors[0]?.id ?? null
    }
    if (!this.monitors.some((monitor) => monitor.id === this.pendingCancel)) {
      this.pendingCancel = null
    }
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (isLowercase(key, "d")) {
      this.confirmCancel()
      return true
    }
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private confirmCancel(): void {
    const monitorId = this.highlighted
    if (!monitorId) return
    if (this.pendingCancel === monitorId) {
      this.pendingCancel = null
      this.options.onCancel(monitorId)
      return
    }
    this.pendingCancel = monitorId
    this.render()
  }

  private render(): void {
    if (this.destroyed) return
    this.header.content = new StyledText([
      fg(VALUE_COLOR)("Market monitors\n"),
      fg(MUTED_COLOR)(`${this.monitors.length} in this chat\n`),
    ])
    this.list.setRows(
      this.monitors.map((monitor) => ({ id: monitor.id, content: monitorRow(monitor) })),
      this.highlighted ?? undefined,
      { preserveScroll: true },
    )
    this.footer.content = new StyledText(this.footerChunks())
    this.renderer.requestRender()
  }

  private footerChunks(): TextChunk[] {
    if (this.monitors.length === 0) {
      return [fg(MUTED_COLOR)("\nNo open market monitors in this chat.\nEsc close")]
    }
    const pending = this.monitors.find((monitor) => monitor.id === this.pendingCancel)
    if (pending) {
      return [fg(CONFIRM_COLOR)(`\nPress d again to cancel ${pending.displayName}'s monitor.`)]
    }
    const selected = this.monitors.find((monitor) => monitor.id === this.highlighted)
    const purpose = selected?.onTrigger?.trim()
    return [
      ...(purpose ? [fg(MUTED_COLOR)(`\nOn trigger: ${purpose}\n`)] : [fg(MUTED_COLOR)("\n")]),
      fg(MUTED_COLOR)("d cancel · ↑↓ monitor · Esc close"),
    ]
  }

  private resizeModal(): void {
    this.modal.width = Math.max(46, Math.min(82, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(22, this.root.height - 2))
  }
}

function monitorRow(monitor: MarketMonitor): StyledText {
  const direction = monitor.direction === "ABOVE" ? "↑" : "↓"
  const directionColor = monitor.direction === "ABOVE" ? ABOVE_COLOR : BELOW_COLOR
  const statusColor = monitor.status === "ARMED"
    ? ARMED_COLOR
    : monitor.status === "TRIGGERED"
      ? TRIGGERED_COLOR
      : MUTED_COLOR
  return new StyledText([
    fg(statusColor)(`${statusMarker(monitor)} `),
    fg(VALUE_COLOR)(monitor.displayName),
    fg(directionColor)(`  ${direction} `),
    fg(VALUE_COLOR)(condition(monitor)),
    fg(MUTED_COLOR)(` · ${basis(monitor)} · ${monitor.repeat.toLowerCase()} · `),
    fg(statusColor)(monitor.status.toLowerCase()),
  ])
}

function condition(monitor: MarketMonitor): string {
  const side = monitor.direction === "ABOVE" ? "above" : "below"
  const level = formatNumber(monitor.triggerPrice)
  if (monitor.kind === "PRICE") return `${side} ${level}`
  const width = monitor.kind.includes("ATR") ? `${formatNumber(monitor.value)} ATR` : `${formatNumber(monitor.value)}%`
  if (monitor.kind.startsWith("TRAILING")) return `trailing ${side} by ${width} @ ${level}`
  return `${side} ${level} (${width})`
}

function basis(monitor: MarketMonitor): string {
  return monitor.basis === "TOUCH" ? "touch" : `${monitor.interval ?? "candle"} close`
}

function statusMarker(monitor: MarketMonitor): string {
  if (monitor.status === "ARMED") return "●"
  if (monitor.status === "TRIGGERED") return "★"
  return "○"
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function order(monitors: MarketMonitor[]): MarketMonitor[] {
  return monitors.filter(isOpenPriceAlert).sort((left, right) => right.createdAt - left.createdAt)
}

function isLowercase(key: KeyEvent, name: string): boolean {
  return key.name === name && !key.ctrl && !key.meta && !key.shift
}
