// Watches live prices against the levels a trader asked to be told about. It
// owns nothing but attention: when a level is reached it says so once, and the
// screen decides how loudly. Nothing here trades, and no alert depends on a
// position existing.
import {
  averageTrueRange,
  closedCandles,
  futuresRangeForInterval,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSource,
} from "./candle.ts"
import {
  advanceAlertTrail,
  alertNeedsCandles,
  createPriceAlert,
  isAlertReached,
  isAtrAlert,
  isTrailingAlert,
  resolveAlertLevel,
  type PriceAlert,
  type PriceAlertDraft,
  type PriceAlertStatus,
  type PriceAlertStore,
} from "./alert.ts"
import type { QuoteUpdate } from "./quote-stream.ts"

// A price this old is treated as no price at all: a dead feed must not look
// like a market standing still just above a level.
const DEFAULT_STALE_PRICE_MS = 20_000
// Candle reads happen on the screen's poll rather than per tick, so a close
// based alert is judged against a window a few polls wide instead of the tick
// one.
const STALE_CANDLE_MS = 90_000
const ATR_PERIOD = 14

export interface AlertTriggerEvent {
  alert: PriceAlert
  // The price that reached the level.
  price: number
  priceAgeMs: number
}

/** How the price feed for an alert's symbol is doing. */
export type AlertFeedState = "live" | "stale" | "missing"

export interface PriceAlertView {
  alert: PriceAlert
  level: number | null
  lastPrice: number | null
  // Distance from the last price to the level, signed toward the level.
  distancePercent: number | null
  feed: AlertFeedState
}

export interface AlertMonitorOptions {
  store: PriceAlertStore
  candles?: CandleSource
  onTrigger: (event: AlertTriggerEvent) => void
  onChange?: () => void
  onError?: (error: unknown) => void
  stalePriceMs?: number
  now?: () => number
}

interface QuoteSample {
  price: number
  timestamp: number
}

export class AlertMonitor {
  private alerts = new Map<string, PriceAlert>()
  private readonly quotes = new Map<string, QuoteSample>()
  // The last closed candle read per instrument and grain, keyed
  // `instrumentUid:interval`. A close-based alert watches these, not ticks.
  private readonly candles = new Map<string, QuoteSample>()
  // Alerts seen at least once with the market on the near side of their level.
  // One written on the far side therefore waits for the market to come back
  // rather than firing the instant it is saved.
  private readonly approaching = new Set<string>()
  private candleRequest: AbortController | null = null
  private destroyed = false

  constructor(private readonly options: AlertMonitorOptions) {}

  /** Seeds from the store. A fired alert stays fired until it is re-armed. */
  async load(): Promise<void> {
    try {
      const stored = await this.options.store.list()
      if (this.destroyed) return
      this.alerts = new Map(stored.map((alert) => [alert.id, alert]))
      this.options.onChange?.()
    } catch (error) {
      this.report(error)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.candleRequest?.abort()
    this.candleRequest = null
  }

  /** Symbols the monitor needs ticks for, so the screen can subscribe to them. */
  symbols(): string[] {
    const symbols = new Set<string>()
    for (const alert of this.alerts.values()) {
      if (alert.status === "ARMED") symbols.add(alert.symbol)
    }
    return [...symbols]
  }

  alert(id: string): PriceAlert | undefined {
    return this.alerts.get(id)
  }

  views(): PriceAlertView[] {
    const now = this.now()
    return [...this.alerts.values()]
      // Newest first: the alert just written is the one being looked for.
      .sort((left, right) => right.createdAt - left.createdAt || left.symbol.localeCompare(right.symbol))
      .map((alert) => {
        // A close-based alert is read from candles, so a contract that never
        // ticks is not a broken alert and must not be reported as one.
        const fromCandles = alert.basis === "CLOSE"
        const sample = fromCandles
          ? this.candles.get(`${alert.instrumentUid}:${alert.interval}`)
          : this.quotes.get(alert.symbol)
        const level = resolveAlertLevel(alert)
        const lastPrice = sample?.price ?? null
        return {
          alert,
          level,
          lastPrice,
          distancePercent: level !== null && lastPrice !== null && lastPrice > 0
            ? ((level - lastPrice) / lastPrice) * 100
            : null,
          feed: sampleState(sample, now, fromCandles ? STALE_CANDLE_MS : this.staleAfter()),
        }
      })
  }

  /** A tick: advances trailing levels and fires any touch alert it reaches. */
  applyQuote(update: QuoteUpdate): void {
    if (this.destroyed || update.lastPrice === null || !Number.isFinite(update.lastPrice)) return
    const now = this.now()
    // Provider timestamps can run ahead of the local clock; a future tick is
    // fresh, not stale.
    this.quotes.set(update.symbol, { price: update.lastPrice, timestamp: Math.min(update.timestamp, now) })
    // A new price moves the distance and feed a watching row shows, whether or
    // not it moves the alert, so the panel hears about it either way.
    let changed = false
    let watched = false

    for (const alert of this.alerts.values()) {
      if (alert.symbol !== update.symbol) continue
      if (alert.basis !== "CLOSE") watched = true
      if (isTrailingAlert(alert.kind) && alert.status === "ARMED") {
        const advanced = advanceAlertTrail(alert, update.lastPrice)
        if (advanced) {
          const moved = { ...alert, ...advanced, updatedAt: now }
          this.alerts.set(alert.id, moved)
          void this.persist(moved)
          changed = true
        }
      }
      if (alert.basis === "TOUCH") changed = this.evaluate(alert.id, { lastPrice: update.lastPrice }, now) || changed
    }
    if (changed || watched) this.options.onChange?.()
  }

  /**
   * Reads candles for the alerts that need them: close-based alerts compare the
   * last finished candle, and ATR trails refresh the width they trail by.
   * Called on the screen's timer.
   */
  async refreshCandleAlerts(): Promise<void> {
    const source = this.options.candles
    if (!source || this.destroyed) return
    const wanted = new Map<string, { instrumentUid: string; interval: CandleInterval }>()
    for (const alert of this.alerts.values()) {
      if (alert.status !== "ARMED" || !alertNeedsCandles(alert) || !alert.interval) continue
      wanted.set(`${alert.instrumentUid}:${alert.interval}`, {
        instrumentUid: alert.instrumentUid,
        interval: alert.interval,
      })
    }
    if (wanted.size === 0) return

    this.candleRequest?.abort()
    const request = new AbortController()
    this.candleRequest = request
    try {
      let changed = false
      for (const { instrumentUid, interval } of wanted.values()) {
        const series = await source.loadCandles(instrumentUid, alertRangeForInterval(interval), interval, {
          signal: request.signal,
          target: "INSTRUMENT",
        })
        if (this.destroyed || request.signal.aborted || this.candleRequest !== request) return
        const now = this.now()
        const closed = closedCandles(series, now)
        const lastClosed = closed.at(-1) ?? null
        // A fresh reading changes what every close-based row displays, so it
        // counts as a change in its own right; see the stop monitor.
        if (lastClosed) {
          this.candles.set(`${instrumentUid}:${interval}`, { price: lastClosed.close, timestamp: now })
          changed = true
        }
        changed = this.applyCandles(instrumentUid, interval, lastClosed, averageTrueRange(closed, ATR_PERIOD), now)
          || changed
      }
      if (changed) this.options.onChange?.()
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) return
      this.report(error)
    } finally {
      if (this.candleRequest === request) this.candleRequest = null
    }
  }

  async saveAlert(draft: PriceAlertDraft): Promise<PriceAlert> {
    const existing = draft.id ? this.alerts.get(draft.id) : undefined
    const alert = { ...createPriceAlert(draft, this.now()), ...(existing ? { createdAt: existing.createdAt } : {}) }
    this.alerts.set(alert.id, alert)
    // An edited alert earns its near-side latch again: its level moved.
    this.approaching.delete(alert.id)
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
      this.report(error)
    }
    this.options.onChange?.()
  }

  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    const alert = this.alerts.get(id)
    if (!alert || alert.status === status) return
    // Re-arming starts the near-side latch over, so a level the market is
    // already beyond cannot fire again the moment it is switched back on.
    if (status === "ARMED") this.approaching.delete(id)
    const updated: PriceAlert = {
      ...alert,
      status,
      ...(status === "ARMED" ? { triggeredAt: null, triggeredPrice: null } : {}),
      updatedAt: this.now(),
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
        const rewidened = { ...alert, atrValue: atr, updatedAt: now }
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
    if (sample.lastPrice !== undefined && this.feedState(alert.symbol, now) !== "live") return false

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
    const triggered: PriceAlert = {
      ...alert,
      status: repeats ? "ARMED" : "TRIGGERED",
      triggeredAt: now,
      triggeredPrice: price,
      updatedAt: now,
    }
    if (repeats) this.approaching.delete(alert.id)
    this.alerts.set(alert.id, triggered)
    void this.persist(triggered)
    this.options.onTrigger({
      alert: triggered,
      price,
      priceAgeMs: Math.max(0, now - (this.quotes.get(alert.symbol)?.timestamp ?? now)),
    })
    return true
  }

  /** Tick freshness, which is what decides whether a touch alert may fire. */
  private feedState(symbol: string, now: number): AlertFeedState {
    return sampleState(this.quotes.get(symbol), now, this.staleAfter())
  }

  private staleAfter(): number {
    return this.options.stalePriceMs ?? DEFAULT_STALE_PRICE_MS
  }

  private async persist(alert: PriceAlert): Promise<void> {
    try {
      await this.options.store.put(alert)
    } catch (error) {
      this.report(error)
    }
  }

  private report(error: unknown): void {
    if (this.destroyed) return
    this.options.onError?.(error)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/**
 * The range to ask for so a futures contract comes back at `interval`. Alerts
 * watch the contracts on the watchlist, and that feed infers the grain from the
 * range rather than taking a requested interval.
 */
export function alertRangeForInterval(interval: CandleInterval): CandleRange {
  return futuresRangeForInterval(interval) ?? "INTRADAY"
}

function sampleState(sample: QuoteSample | undefined, now: number, staleAfter: number): AlertFeedState {
  if (!sample) return "missing"
  return now - sample.timestamp > staleAfter ? "stale" : "live"
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
