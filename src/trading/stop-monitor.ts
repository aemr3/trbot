// Watches live prices against the protective levels a trader has set and says
// when one is reached. It never trades: every breach becomes a proposal the
// screen confirms. Everything that decides whether an exit is safe lives here,
// not in the panel.
import {
  averageTrueRange,
  closedCandles,
  futuresRangeForInterval,
  type Candle,
  type CandleInterval,
  type CandleRange,
  type CandleSource,
} from "../market/candle.ts"
import type { QuoteUpdate } from "../market/quote-stream.ts"
import type { AccountPosition } from "./account.ts"
import type { ViopOrderSide } from "./order.ts"
import {
  advanceTrailingStop,
  createStopRule,
  isAtrStopRule,
  isStopBreached,
  isTrailingStopRule,
  reconcileStopRule,
  resolveStopLevel,
  stopExitSide,
  stopRuleNeedsCandles,
  stopRuleQuantity,
  type StopRule,
  type StopRuleDraft,
  type StopRuleStatus,
  type StopRuleStore,
} from "./stop.ts"

// A price this old is treated as no price at all: a dead feed must not look
// like a market standing still just above a stop.
const DEFAULT_STALE_PRICE_MS = 20_000
const ATR_PERIOD = 14

export interface StopTriggerEvent {
  rule: StopRule
  position: AccountPosition
  // The price that reached the level.
  price: number
  quantity: number
  side: ViopOrderSide
  priceAgeMs: number
}

/** How the price feed for a rule's symbol is doing. */
export type StopFeedState = "live" | "stale" | "missing"

export interface StopRuleView {
  rule: StopRule
  level: number | null
  lastPrice: number | null
  // Distance from the last price to the level, signed toward the level.
  distancePercent: number | null
  feed: StopFeedState
  hasPosition: boolean
}

export interface StopMonitorOptions {
  store: StopRuleStore
  candles?: CandleSource
  onTrigger: (event: StopTriggerEvent) => void
  onChange?: () => void
  onError?: (error: unknown) => void
  stalePriceMs?: number
  now?: () => number
}

interface QuoteSample {
  price: number
  timestamp: number
}

export class StopMonitor {
  private rules = new Map<string, StopRule>()
  private positions = new Map<string, AccountPosition>()
  private readonly quotes = new Map<string, QuoteSample>()
  // Rules seen at least once with the market on the safe side of their level.
  // A rule typed on the wrong side of the market therefore waits instead of
  // firing the instant it is saved.
  private readonly safe = new Set<string>()
  private candleRequest: AbortController | null = null
  private destroyed = false

  constructor(private readonly options: StopMonitorOptions) {}

  /** Seeds from the store. Triggered rules stay triggered — never auto-sent. */
  async load(): Promise<void> {
    try {
      const stored = await this.options.store.list()
      if (this.destroyed) return
      this.rules = new Map(stored.map((rule) => [rule.id, rule]))
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
    for (const rule of this.rules.values()) {
      if (rule.status === "ARMED" || rule.status === "TRIGGERED") symbols.add(rule.symbol)
    }
    return [...symbols]
  }

  rule(id: string): StopRule | undefined {
    return this.rules.get(id)
  }

  views(): StopRuleView[] {
    const now = this.now()
    return [...this.rules.values()]
      .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.createdAt - right.createdAt)
      .map((rule) => {
        const sample = this.quotes.get(rule.symbol)
        const level = resolveStopLevel(rule)
        const lastPrice = sample?.price ?? null
        return {
          rule,
          level,
          lastPrice,
          distancePercent: level !== null && lastPrice !== null && lastPrice > 0
            ? ((level - lastPrice) / lastPrice) * 100
            : null,
          feed: this.feedState(rule.symbol, now),
          hasPosition: this.positions.has(rule.instrumentUid),
        }
      })
  }

  /**
   * Positions arrive from the account panel. A rule whose position closed is
   * finished; one whose position flipped side goes on hold rather than exiting
   * the wrong way.
   */
  setPositions(positions: AccountPosition[]): void {
    if (this.destroyed) return
    this.positions = new Map(positions.map((position) => [position.uid, position]))
    const now = this.now()
    let changed = false
    for (const rule of this.rules.values()) {
      const reconciled = reconcileStopRule(rule, this.positions.get(rule.instrumentUid), now)
      if (reconciled === rule) continue
      this.rules.set(rule.id, reconciled)
      void this.persist(reconciled)
      changed = true
    }
    if (changed) this.options.onChange?.()
  }

  /** A tick: advances trailing levels and fires any touch rule it reaches. */
  applyQuote(update: QuoteUpdate): void {
    if (this.destroyed || update.lastPrice === null || !Number.isFinite(update.lastPrice)) return
    const now = this.now()
    // Provider timestamps can run ahead of the local clock; a future tick is
    // fresh, not stale.
    this.quotes.set(update.symbol, { price: update.lastPrice, timestamp: Math.min(update.timestamp, now) })
    let changed = false

    for (const rule of this.rules.values()) {
      if (rule.symbol !== update.symbol) continue
      if (isTrailingStopRule(rule.kind) && rule.status === "ARMED") {
        const advanced = advanceTrailingStop(rule, update.lastPrice)
        if (advanced) {
          const moved = { ...rule, ...advanced, updatedAt: now }
          this.rules.set(rule.id, moved)
          void this.persist(moved)
          changed = true
        }
      }
      if (rule.basis === "TOUCH") changed = this.evaluate(rule.id, { lastPrice: update.lastPrice }, now) || changed
    }
    if (changed) this.options.onChange?.()
  }

  /**
   * Reads candles for the rules that need them: close-based rules compare the
   * last finished candle, and ATR trails refresh the width they trail by.
   * Called on the screen's timer.
   */
  async refreshCandleRules(): Promise<void> {
    const source = this.options.candles
    if (!source || this.destroyed) return
    const wanted = new Map<string, { instrumentUid: string; interval: CandleInterval }>()
    for (const rule of this.rules.values()) {
      if (rule.status !== "ARMED" || !stopRuleNeedsCandles(rule) || !rule.interval) continue
      wanted.set(`${rule.instrumentUid}:${rule.interval}`, { instrumentUid: rule.instrumentUid, interval: rule.interval })
    }
    if (wanted.size === 0) return

    this.candleRequest?.abort()
    const request = new AbortController()
    this.candleRequest = request
    try {
      let changed = false
      for (const { instrumentUid, interval } of wanted.values()) {
        const series = await source.loadCandles(instrumentUid, rangeForInterval(interval), interval, {
          signal: request.signal,
          target: "INSTRUMENT",
        })
        if (this.destroyed || request.signal.aborted || this.candleRequest !== request) return
        const now = this.now()
        const closed = closedCandles(series, now)
        const lastClosed = closed.at(-1) ?? null
        const atr = averageTrueRange(closed, ATR_PERIOD)
        changed = this.applyCandles(instrumentUid, interval, lastClosed, atr, now) || changed
      }
      if (changed) this.options.onChange?.()
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) return
      this.report(error)
    } finally {
      if (this.candleRequest === request) this.candleRequest = null
    }
  }

  async saveRule(draft: StopRuleDraft): Promise<StopRule> {
    const existing = draft.id ? this.rules.get(draft.id) : undefined
    const rule = { ...createStopRule(draft, this.now()), ...(existing ? { createdAt: existing.createdAt } : {}) }
    this.rules.set(rule.id, rule)
    // An edited rule earns its safe-tick latch again: its level moved.
    this.safe.delete(rule.id)
    await this.persist(rule)
    this.options.onChange?.()
    return rule
  }

  async removeRule(id: string): Promise<void> {
    this.rules.delete(id)
    this.safe.delete(id)
    try {
      await this.options.store.remove(id)
    } catch (error) {
      this.report(error)
    }
    this.options.onChange?.()
  }

  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    const rule = this.rules.get(id)
    if (!rule || rule.status === status) return
    // Re-arming starts the safe-tick latch over, so a level the market has
    // already passed cannot fire the moment it is switched back on.
    if (status === "ARMED") this.safe.delete(id)
    const updated: StopRule = { ...rule, status, updatedAt: this.now() }
    this.rules.set(id, updated)
    await this.persist(updated)
    this.options.onChange?.()
  }

  /**
   * Closes out a trigger. A submitted exit ends the rule and stands the other
   * levels on that position down — the position it protected is gone. A
   * cancelled one leaves the rule triggered for the trader to decide on.
   */
  async resolveTrigger(id: string, outcome: "SUBMITTED" | "CANCELLED", exitOrderUid?: string): Promise<void> {
    const rule = this.rules.get(id)
    if (!rule) return
    const now = this.now()
    if (outcome === "CANCELLED") {
      const cancelled: StopRule = { ...rule, status: "PAUSED", updatedAt: now }
      this.rules.set(id, cancelled)
      await this.persist(cancelled)
      this.options.onChange?.()
      return
    }

    const done: StopRule = { ...rule, status: "DONE", exitOrderUid: exitOrderUid ?? null, updatedAt: now }
    this.rules.set(id, done)
    await this.persist(done)
    for (const sibling of this.rules.values()) {
      if (sibling.id === id || sibling.instrumentUid !== rule.instrumentUid || sibling.status !== "ARMED") continue
      const paused: StopRule = { ...sibling, status: "PAUSED", updatedAt: now }
      this.rules.set(sibling.id, paused)
      await this.persist(paused)
    }
    this.options.onChange?.()
  }

  /** Applies a fresh candle reading to every rule on that instrument. */
  private applyCandles(
    instrumentUid: string,
    interval: CandleInterval,
    lastClosed: Candle | null,
    atr: number | null,
    now: number,
  ): boolean {
    let changed = false
    for (const rule of this.rules.values()) {
      if (rule.instrumentUid !== instrumentUid || rule.interval !== interval || rule.status !== "ARMED") continue
      if (atr !== null && isAtrStopRule(rule.kind) && isTrailingStopRule(rule.kind) && atr !== rule.atrValue) {
        // Only the trail refreshes its width; a standing ATR level was measured
        // once on purpose and must not wander under the position.
        const rewidened = { ...rule, atrValue: atr, updatedAt: now }
        this.rules.set(rule.id, rewidened)
        void this.persist(rewidened)
        changed = true
      }
      if (rule.basis === "CLOSE") changed = this.evaluate(rule.id, { closedCandle: lastClosed }, now) || changed
    }
    return changed
  }

  /**
   * Fires a rule if the sample reached its level. The rule is marked triggered
   * and persisted before anything is proposed, so a crash between here and the
   * confirmation leaves a rule that is visibly spent rather than silently live.
   */
  private evaluate(id: string, sample: { lastPrice?: number; closedCandle?: Candle | null }, now: number): boolean {
    const rule = this.rules.get(id)
    if (!rule || rule.status !== "ARMED") return false
    const position = this.positions.get(rule.instrumentUid)
    if (!position || position.quantity === 0) return false
    if (sample.lastPrice !== undefined && this.feedState(rule.symbol, now) !== "live") return false

    const breached = isStopBreached(rule, sample)
    if (!breached) {
      this.safe.add(rule.id)
      return false
    }
    if (!this.safe.has(rule.id)) return false

    const price = rule.basis === "CLOSE" ? sample.closedCandle?.close : sample.lastPrice
    if (price === undefined || price === null) return false
    const quantity = stopRuleQuantity(rule, position)
    if (quantity <= 0) return false

    const triggered: StopRule = { ...rule, status: "TRIGGERED", triggeredAt: now, updatedAt: now }
    this.rules.set(rule.id, triggered)
    void this.persist(triggered)
    this.options.onTrigger({
      rule: triggered,
      position,
      price,
      quantity,
      side: stopExitSide(rule.side),
      priceAgeMs: Math.max(0, now - (this.quotes.get(rule.symbol)?.timestamp ?? now)),
    })
    return true
  }

  private feedState(symbol: string, now: number): StopFeedState {
    const sample = this.quotes.get(symbol)
    if (!sample) return "missing"
    const staleAfter = this.options.stalePriceMs ?? DEFAULT_STALE_PRICE_MS
    return now - sample.timestamp > staleAfter ? "stale" : "live"
  }

  private async persist(rule: StopRule): Promise<void> {
    try {
      await this.options.store.put(rule)
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
 * The range to ask for so a futures contract comes back at `interval`. Rules
 * protect futures positions, and that feed infers the grain from the range
 * rather than taking a requested interval.
 */
export function rangeForInterval(interval: CandleInterval): CandleRange {
  return futuresRangeForInterval(interval) ?? "INTRADAY"
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
