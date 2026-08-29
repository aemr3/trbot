// Watches live prices against the levels a trader or agent asked to watch. It
// owns nothing but attention: when a level is reached it says so once, and the
// screen decides how loudly. Nothing here trades, and no alert depends on a
// position existing.
import type { Candle, CandleInterval, CandleSource } from "./candle.ts"
import { LevelMonitorFeed, type LevelMonitorFeedState } from "./level-monitor-feed.ts"
import {
  advanceAlertTrail,
  alertNeedsCandles,
  isAlertReached,
  isAtrAlert,
  isTrailingAlert,
  resolveAlertLevel,
  PriceAlertSchema,
  type PriceAlert,
  type PriceAlertDraft,
  type PriceAlertStatus,
} from "./alert.ts"
import type { QuoteUpdate } from "./quote-stream.ts"
import { z } from "zod"

export interface AlertTriggerEvent<TAlert extends PriceAlert = PriceAlert> {
  alert: TAlert
  // The price that reached the level.
  price: number
  priceAgeMs: number
}

export interface PriceRuleStore<TAlert extends PriceAlert> {
  list(): Promise<TAlert[]>
  put(alert: TAlert): Promise<void>
  remove(id: string): Promise<void>
}

/** How the price feed for an alert's symbol is doing. */
export type AlertFeedState = LevelMonitorFeedState

export interface PriceAlertView<TAlert extends PriceAlert = PriceAlert> {
  alert: TAlert
  level: number | null
  lastPrice: number | null
  // Distance from the last price to the level, signed toward the level.
  distancePercent: number | null
  feed: AlertFeedState
}

export const AlertTriggerEventSchema: z.ZodType<AlertTriggerEvent> = z.object({
  alert: PriceAlertSchema,
  price: z.number(),
  priceAgeMs: z.number(),
})

export const PriceAlertViewSchema: z.ZodType<PriceAlertView> = z.object({
  alert: PriceAlertSchema,
  level: z.number().nullable(),
  lastPrice: z.number().nullable(),
  distancePercent: z.number().nullable(),
  feed: z.enum(["live", "stale", "missing"]),
})

export interface AlertMonitorOptions<
  TAlert extends PriceAlert = PriceAlert,
  TDraft extends PriceAlertDraft = PriceAlertDraft,
> {
  store: PriceRuleStore<TAlert>
  create: (draft: TDraft, now: number) => TAlert
  candles?: CandleSource
  onTrigger: (event: AlertTriggerEvent<TAlert>) => void
  /** Called only after the fired state is durable; suitable for retryable downstream work. */
  onTriggerPersisted?: (event: AlertTriggerEvent<TAlert>) => void
  onChange?: () => void
  onError?: (cause: unknown) => void
  stalePriceMs?: number
  now?: () => number
}

export class AlertMonitor<
  TAlert extends PriceAlert = PriceAlert,
  TDraft extends PriceAlertDraft = PriceAlertDraft,
> {
  private alerts = new Map<string, TAlert>()
  private readonly feed: LevelMonitorFeed
  // Alerts seen at least once with the market on the near side of their level.
  // One written on the far side therefore waits for the market to come back
  // rather than firing the instant it is saved.
  private readonly approaching = new Set<string>()

  constructor(private readonly options: AlertMonitorOptions<TAlert, TDraft>) {
    this.feed = new LevelMonitorFeed(options)
  }

  /** Seeds from the store. A fired alert stays fired until it is re-armed. */
  async load(): Promise<void> {
    try {
      const stored = await this.options.store.list()
      if (this.feed.destroyed) return
      this.alerts = new Map(stored.map((alert) => [alert.id, alert]))
      this.options.onChange?.()
    } catch (error) {
      this.feed.report(error)
    }
  }

  destroy(): void {
    this.feed.destroy()
  }

  /** Symbols the monitor needs ticks for, so the screen can subscribe to them. */
  symbols(): string[] {
    const symbols = new Set<string>()
    for (const alert of this.alerts.values()) {
      if (alert.status === "ARMED") symbols.add(alert.symbol)
    }
    return [...symbols]
  }

  alert(id: string): TAlert | undefined {
    return this.alerts.get(id)
  }

  views(): PriceAlertView<TAlert>[] {
    const now = this.feed.now()
    return [...this.alerts.values()]
      // Newest first: the alert just written is the one being looked for.
      .sort((left, right) => right.createdAt - left.createdAt || left.symbol.localeCompare(right.symbol))
      .map((alert) => {
        // A close-based alert is read from candles, so a contract that never
        // ticks is not a broken alert and must not be reported as one.
        return {
          alert,
          ...this.feed.view(alert, resolveAlertLevel(alert), now),
        }
      })
  }

  /** A tick: advances trailing levels and fires any touch alert it reaches. */
  applyQuote(update: QuoteUpdate): void {
    const sample = this.feed.recordQuote(update)
    if (!sample) return
    const now = sample.observedAt
    // A new price moves the distance and feed a watching row shows, whether or
    // not it moves the alert, so the panel hears about it either way.
    let changed = false
    let watched = false

    for (const alert of this.alerts.values()) {
      if (alert.symbol !== update.symbol) continue
      if (alert.basis !== "CLOSE") watched = true
      if (isTrailingAlert(alert.kind) && alert.status === "ARMED") {
        const advanced = advanceAlertTrail(alert, sample.price)
        if (advanced) {
          const moved = { ...alert, ...advanced, updatedAt: now }
          this.alerts.set(alert.id, moved)
          void this.persist(moved)
          changed = true
        }
      }
      if (alert.basis === "TOUCH") changed = this.evaluate(alert.id, { lastPrice: sample.price }, now) || changed
    }
    if (changed || watched) this.options.onChange?.()
  }

  /**
   * Reads candles for the alerts that need them: close-based alerts compare the
   * last finished candle, and ATR trails refresh the width they trail by.
   * Called on the screen's timer.
   */
  async refreshCandleAlerts(): Promise<void> {
    const wanted = new Map<string, { instrumentUid: string; interval: CandleInterval }>()
    for (const alert of this.alerts.values()) {
      if (alert.status !== "ARMED" || !alertNeedsCandles(alert) || !alert.interval) continue
      wanted.set(`${alert.instrumentUid}:${alert.interval}`, {
        instrumentUid: alert.instrumentUid,
        interval: alert.interval,
      })
    }
    if (wanted.size === 0) return
    const changed = await this.feed.refreshCandles(
      wanted.values(),
      ({ instrumentUid, interval, lastClosed, atr, now }) =>
        this.applyCandles(instrumentUid, interval, lastClosed, atr, now),
    )
    if (changed) this.options.onChange?.()
  }

  async saveAlert(draft: TDraft): Promise<TAlert> {
    const existing = draft.id ? this.alerts.get(draft.id) : undefined
    const alert = this.options.create(draft, this.feed.now())
    if (existing) alert.createdAt = existing.createdAt
    this.alerts.set(alert.id, alert)
    // An edited alert earns its near-side latch again: its level moved. A fresh
    // cached quote can establish that side immediately, so the first trade through
    // the level is not discarded while waiting for another near-side tick.
    this.approaching.delete(alert.id)
    this.seedApproachFromQuote(alert, this.feed.now())
    await this.persist(alert)
    this.options.onChange?.()
    return alert
  }

  async removeAlert(id: string): Promise<void> {
    this.alerts.delete(id)
    this.approaching.delete(id)
    try {
      await this.options.store.remove(id)
    } catch (error) {
      this.feed.report(error)
    }
    this.options.onChange?.()
  }

  /** Restores an exact journal snapshot after a conversation rewind. */
  async restoreAlert(id: string, alert: TAlert | null): Promise<void> {
    if (alert) await this.options.store.put(alert)
    else await this.options.store.remove(id)
    if (alert) {
      this.alerts.set(id, alert)
      this.approaching.delete(id)
      this.seedApproachFromQuote(alert, this.feed.now())
    } else {
      this.alerts.delete(id)
      this.approaching.delete(id)
    }
    this.options.onChange?.()
  }

  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    const alert = this.alerts.get(id)
    if (!alert || alert.status === status) return
    // Re-arming starts the near-side latch over, so a level the market is
    // already beyond cannot fire again the moment it is switched back on.
    if (status === "ARMED") this.approaching.delete(id)
    const updated: TAlert = {
      ...alert,
      status,
      updatedAt: this.feed.now(),
    }
    if (status === "ARMED") {
      updated.triggeredAt = null
      updated.triggeredPrice = null
      updated.triggerId = null
    }
    this.alerts.set(id, updated)
    await this.persist(updated)
    this.options.onChange?.()
  }

  /** Applies a fresh candle reading to every alert on that instrument. */
  private applyCandles(
    instrumentUid: string,
    interval: CandleInterval,
    lastClosed: Candle | null,
    atr: number | null,
    now: number,
  ): boolean {
    let changed = false
    for (const alert of this.alerts.values()) {
      if (alert.instrumentUid !== instrumentUid || alert.interval !== interval || alert.status !== "ARMED") continue
      if (atr !== null && isAtrAlert(alert.kind) && isTrailingAlert(alert.kind) && atr !== alert.atrValue) {
        // Only the trail refreshes its width; a standing ATR level was measured
        // once on purpose and must not wander.
        const rewidened: TAlert = { ...alert, atrValue: atr, updatedAt: now }
        this.alerts.set(alert.id, rewidened)
        void this.persist(rewidened)
        changed = true
      }
      if (alert.basis === "CLOSE") changed = this.evaluate(alert.id, { closedCandle: lastClosed }, now) || changed
    }
    return changed
  }

  /**
   * Fires an alert if the sample reached its level. It is marked triggered and
   * persisted before anything is announced, so a crash between here and the
   * popup leaves an alert that has visibly fired rather than one that silently
   * fires again on the next tick.
   */
  private evaluate(id: string, sample: { lastPrice?: number; closedCandle?: Candle | null }, now: number): boolean {
    const alert = this.alerts.get(id)
    if (!alert || alert.status !== "ARMED") return false
    if (sample.lastPrice !== undefined && this.feed.quoteState(alert.symbol, now) !== "live") return false

    if (!isAlertReached(alert, sample)) {
      this.approaching.add(alert.id)
      return false
    }
    if (!this.approaching.has(alert.id)) return false

    const price = alert.basis === "CLOSE" ? sample.closedCandle?.close : sample.lastPrice
    if (price === undefined || price === null) return false

    // A repeating alert stays armed, but gives up its latch: the price has to
    // come back to the near side before it can ring again, so a market sitting
    // beyond the level announces itself once per crossing rather than per tick.
    const repeats = alert.repeat === "ALWAYS"
    const triggered: TAlert = {
      ...alert,
      status: repeats ? "ARMED" : "TRIGGERED",
      triggeredAt: now,
      triggeredPrice: price,
      triggerId: crypto.randomUUID(),
      updatedAt: now,
    }
    if (repeats) this.approaching.delete(alert.id)
    this.alerts.set(alert.id, triggered)
    const event = {
      alert: triggered,
      price,
      priceAgeMs: this.feed.quoteAgeMs(alert.symbol, now),
    }
    const persistence = this.persist(triggered)
    this.options.onTrigger(event)
    if (this.options.onTriggerPersisted) {
      void persistence.then((stored) => {
        if (stored && !this.feed.destroyed) this.options.onTriggerPersisted?.(event)
      })
    }
    return true
  }

  /** Arms a touch crossing from a live quote observed before the rule was saved. */
  private seedApproachFromQuote(alert: TAlert, now: number): void {
    if (alert.basis !== "TOUCH" || this.feed.quoteState(alert.symbol, now) !== "live") return
    const quote = this.feed.quote(alert.symbol)
    if (quote && !isAlertReached(alert, { lastPrice: quote.price })) this.approaching.add(alert.id)
  }

  private async persist(alert: TAlert): Promise<boolean> {
    try {
      await this.options.store.put(alert)
      return true
    } catch (error) {
      this.feed.report(error)
      return false
    }
  }
}
