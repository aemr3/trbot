import { AlertMonitor, type AlertTriggerEvent } from "@trbot/market/alert-monitor.ts"
import type { PriceAlert, PriceAlertDraft, PriceAlertStatus, PriceAlertStore } from "@trbot/market/alert.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"

export interface AlertControllerOptions {
  store: PriceAlertStore
  candles?: CandleSource
  broadcast: (event: AlertControllerEvent) => void
  onError?: (error: unknown) => void
  now?: () => number
}

export type AlertControllerEvent = { type: "triggered"; event: AlertTriggerEvent } | { type: "changed" }

/**
 * Runs price alerts on the server. Unlike a stop, a fired alert places no order,
 * so it simply waits: it is announced to whoever is attached and stays announced
 * until a client dismisses or re-arms it.
 */
export class AlertController {
  private readonly monitor: AlertMonitor
  private readonly fired = new Map<string, AlertTriggerEvent>()

  constructor(private readonly options: AlertControllerOptions) {
    this.monitor = new AlertMonitor({
      store: options.store,
      candles: options.candles,
      onTrigger: (event) => this.onTrigger(event),
      onChange: () => options.broadcast({ type: "changed" }),
      onError: (error) => options.onError?.(error),
      now: options.now,
    })
  }

  get alerts() {
    return this.monitor
  }

  /** Loads durable price alerts. */
  async load(): Promise<void> {
    await this.monitor.load()
  }

  symbols(): string[] {
    return this.monitor.symbols()
  }

  /**
   * Editing goes through here rather than through the store, for the same reason
   * stop rules do: the monitor watches what it holds in memory, so a write that
   * reaches the database behind its back is an alert that exists but never fires.
   */
  list(): PriceAlert[] {
    return this.monitor.views().map((view) => view.alert)
  }

  async save(draft: PriceAlertDraft): Promise<PriceAlert> {
    const alert = await this.monitor.saveAlert(draft)
    // Same as a close-based stop rule: read its candles now instead of leaving
    // it without a level until the poll comes round.
    void this.monitor.refreshCandleAlerts().catch((error: unknown) => this.options.onError?.(error))
    return alert
  }

  async remove(id: string): Promise<void> {
    this.fired.delete(id)
    await this.monitor.removeAlert(id)
  }

  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    // Pausing or re-arming answers a fired alert, so it stops being outstanding.
    if (status !== "TRIGGERED") this.fired.delete(id)
    await this.monitor.setStatus(id, status)
  }

  applyQuote(update: QuoteUpdate): void {
    this.monitor.applyQuote(update)
  }

  /** Alerts that fired while nobody was attached, replayed on connect. */
  outstanding(): AlertControllerEvent[] {
    return [...this.fired.values()].map((event) => ({ type: "triggered" as const, event }))
  }

  decide(alertId: string, decision: "dismiss" | "rearm"): void {
    this.fired.delete(alertId)
    if (decision === "rearm") {
      void this.monitor.setStatus(alertId, "ARMED").catch((error: unknown) => this.options.onError?.(error))
    }
  }

  destroy(): void {
    this.fired.clear()
    this.monitor.destroy()
  }

  private onTrigger(event: AlertTriggerEvent): void {
    this.fired.set(event.alert.id, event)
    this.options.broadcast({ type: "triggered", event })
  }
}
