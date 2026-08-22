import { AlertMonitor, type AlertTriggerEvent } from "@trbot/market/alert-monitor.ts"
import {
  createMarketMonitor,
  type MarketMonitor,
  type MarketMonitorDraft,
  type MarketMonitorStore,
} from "@trbot/market/market-monitor.ts"
import { isOpenPriceAlert, type PriceAlertStatus } from "@trbot/market/alert.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"

export type MarketMonitorTriggerEvent = AlertTriggerEvent<MarketMonitor>

export interface MarketMonitorControllerOptions {
  store: MarketMonitorStore
  candles?: CandleSource
  onTrigger: (event: MarketMonitorTriggerEvent) => Promise<void>
  onChange?: () => void
  onError?: (cause: unknown) => void
  now?: () => number
}

/** Runs agent-owned market conditions and resumes their chat after durable triggers. */
export class MarketMonitorController {
  private readonly engine: AlertMonitor<MarketMonitor, MarketMonitorDraft>

  constructor(private readonly options: MarketMonitorControllerOptions) {
    this.engine = new AlertMonitor({
      store: options.store,
      candles: options.candles,
      create: createMarketMonitor,
      onTrigger: () => {},
      onTriggerPersisted: (event) => this.wakeChat(event),
      onChange: options.onChange,
      onError: options.onError,
      now: options.now,
    })
  }

  /** Reloads durable monitors and retries any trigger whose chat handoff was interrupted. */
  async load(): Promise<void> {
    await this.engine.load()
    for (const { alert: monitor } of this.engine.views()) {
      if (monitor.triggeredAt === null || monitor.triggeredPrice === null || !monitor.triggerId) continue
      this.wakeChat({ alert: monitor, price: monitor.triggeredPrice, priceAgeMs: 0 })
    }
  }

  list(): MarketMonitor[] {
    return this.engine.views().map((view) => view.alert).filter(isOpenPriceAlert)
  }

  get(id: string): MarketMonitor | null {
    return this.engine.alert(id) ?? null
  }

  async save(draft: MarketMonitorDraft): Promise<MarketMonitor> {
    const monitor = await this.engine.saveAlert(draft)
    void this.engine.refreshCandleAlerts().catch((cause: unknown) => this.options.onError?.(cause))
    return monitor
  }

  setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    return this.engine.setStatus(id, status)
  }

  remove(id: string): Promise<void> {
    return this.engine.removeAlert(id)
  }

  restore(id: string, monitor: MarketMonitor | null): Promise<void> {
    return this.engine.restoreAlert(id, monitor)
  }

  symbols(): string[] {
    return this.engine.symbols()
  }

  applyQuote(update: QuoteUpdate): void {
    this.engine.applyQuote(update)
  }

  refreshCandles(): Promise<void> {
    return this.engine.refreshCandleAlerts()
  }

  destroy(): void {
    this.engine.destroy()
  }

  private wakeChat(event: MarketMonitorTriggerEvent): void {
    void this.options.onTrigger(event).catch((cause: unknown) => this.options.onError?.(cause))
  }
}
