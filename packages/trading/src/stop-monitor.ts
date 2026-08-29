// Watches live prices against the protective levels a trader has set and says
// when one is reached. It never trades: every breach becomes a proposal the
// screen confirms. Everything that decides whether an exit is safe lives here,
// not in the panel.
import {
  type Candle,
  type CandleInterval,
  type CandleSource,
} from "@trbot/market/candle.ts"
import { LevelMonitorFeed, type LevelMonitorFeedState } from "@trbot/market/level-monitor-feed.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import { AccountPositionSchema, type AccountPosition } from "./account.ts"
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
  StopRuleSchema,
  type StopRule,
  type StopRuleDraft,
  type StopRuleStatus,
  type StopRuleStore,
} from "./stop.ts"
import { z } from "zod"

/**
 * How a fired stop ended.
 *
 * `UNKNOWN` is not a kind of failure. It means the exit may be live and nobody
 * can say — a dropped response looks the same as an order that never left, and
 * calling that "failed" tells a trader their position is still open when it may
 * not be. It stands the rule down like the others, because re-arming something
 * that may already have exited is the one thing that must not happen.
 */
export const STOP_OUTCOMES = ["SUBMITTED", "CANCELLED", "FAILED", "UNKNOWN"] as const
export type StopOutcome = (typeof STOP_OUTCOMES)[number]

interface StopExitSubmission {
  orderUid: string
  quantity: number
  // Snapshot that produced the trigger. The live position feed may already
  // show the partial fill by the time the submission response comes back.
  positionQuantity: number
}

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
export type StopFeedState = LevelMonitorFeedState

export interface StopRuleView {
  rule: StopRule
  level: number | null
  lastPrice: number | null
  // Distance from the last price to the level, signed toward the level.
  distancePercent: number | null
  feed: StopFeedState
  hasPosition: boolean
}

export const StopTriggerEventSchema: z.ZodType<StopTriggerEvent> = z.object({
  rule: StopRuleSchema,
  position: AccountPositionSchema,
  price: z.number(),
  quantity: z.number(),
  side: z.enum(["BUY", "SELL"]),
  priceAgeMs: z.number(),
})

export const StopRuleViewSchema: z.ZodType<StopRuleView> = z.object({
  rule: StopRuleSchema,
  level: z.number().nullable(),
  lastPrice: z.number().nullable(),
  distancePercent: z.number().nullable(),
  feed: z.enum(["live", "stale", "missing"]),
  hasPosition: z.boolean(),
})

export interface StopMonitorOptions {
  store: StopRuleStore
  candles?: CandleSource
  onTrigger: (event: StopTriggerEvent) => void
  onChange?: () => void
  onError?: (cause: unknown) => void
  stalePriceMs?: number
  now?: () => number
}

export class StopMonitor {
  private rules = new Map<string, StopRule>()
  private positions = new Map<string, AccountPosition>()
  private readonly feed: LevelMonitorFeed
  // Rules seen at least once with the market on the safe side of their level.
  // A rule typed on the wrong side of the market therefore waits instead of
  // firing the instant it is saved.
  private readonly safe = new Set<string>()
  constructor(private readonly options: StopMonitorOptions) {
    this.feed = new LevelMonitorFeed(options)
  }

  /** Seeds from the store. Triggered rules stay triggered — never auto-sent. */
  async load(): Promise<void> {
    try {
      const stored = await this.options.store.list()
      if (this.feed.destroyed) return
      this.rules = new Map(stored.map((rule) => [rule.id, rule]))
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
    for (const rule of this.rules.values()) {
      if (rule.status === "ARMED" || rule.status === "TRIGGERED") symbols.add(rule.symbol)
    }
    return [...symbols]
  }

  rule(id: string): StopRule | undefined {
    return this.rules.get(id)
  }

  views(): StopRuleView[] {
    const now = this.feed.now()
    return [...this.rules.values()]
      // Newest first: the rule just written is the one being looked for.
      .sort((left, right) => right.createdAt - left.createdAt || left.symbol.localeCompare(right.symbol))
      .map((rule) => {
        // A close-based rule is read from candles, so a contract that never
        // ticks is not a broken rule and must not be reported as one.
        return {
          rule,
          ...this.feed.view(rule, resolveStopLevel(rule), now),
          hasPosition: this.positions.has(rule.instrumentUid),
        }
      })
  }

  /**
   * Positions arrive from the account panel. A rule whose position closed is
   * finished; one whose position flipped side goes on hold rather than exiting
   * the wrong way.
   *
   * Only call this with positions the account has actually reported. An empty
   * array is read as "everything is closed" and ends every rule on the list, so
   * passing a placeholder before the account answers destroys the rule set.
   */
  setPositions(positions: AccountPosition[]): void {
    if (this.feed.destroyed) return
    this.positions = new Map(positions.map((position) => [position.uid, position]))
    const now = this.feed.now()
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
    const sample = this.feed.recordQuote(update)
    if (!sample) return
    const now = sample.observedAt
    // A new price moves the distance and feed a watching row shows, whether or
    // not it moves the rule, so the panel hears about it either way.
    let changed = false
    let watched = false

    for (const rule of this.rules.values()) {
      if (rule.symbol !== update.symbol) continue
      if (rule.basis !== "CLOSE") watched = true
      if (isTrailingStopRule(rule.kind) && rule.status === "ARMED") {
        const advanced = advanceTrailingStop(rule, sample.price)
        if (advanced) {
          const moved = { ...rule, ...advanced, updatedAt: now }
          this.rules.set(rule.id, moved)
          void this.persist(moved)
          changed = true
        }
      }
      if (rule.basis === "TOUCH") changed = this.evaluate(rule.id, { lastPrice: sample.price }, now) || changed
    }
    if (changed || watched) this.options.onChange?.()
  }

  /**
   * Reads candles for the rules that need them: close-based rules compare the
   * last finished candle, and ATR trails refresh the width they trail by.
   * Called on the screen's timer.
   */
  async refreshCandleRules(): Promise<void> {
    const wanted = new Map<string, { instrumentUid: string; interval: CandleInterval }>()
    for (const rule of this.rules.values()) {
      if (rule.status !== "ARMED" || !stopRuleNeedsCandles(rule) || !rule.interval) continue
      wanted.set(`${rule.instrumentUid}:${rule.interval}`, { instrumentUid: rule.instrumentUid, interval: rule.interval })
    }
    if (wanted.size === 0) return
    const changed = await this.feed.refreshCandles(
      wanted.values(),
      ({ instrumentUid, interval, lastClosed, atr, now }) =>
        this.applyCandles(instrumentUid, interval, lastClosed, atr, now),
    )
    if (changed) this.options.onChange?.()
  }

  async saveRule(draft: StopRuleDraft): Promise<StopRule> {
    const existing = draft.id ? this.rules.get(draft.id) : undefined
    const rule = createStopRule(draft, this.feed.now())
    if (existing) rule.createdAt = existing.createdAt
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
      this.feed.report(error)
    }
    this.options.onChange?.()
  }

  /** Restores an exact journal snapshot after a conversation rewind. */
  async restoreRule(id: string, rule: StopRule | null): Promise<void> {
    if (rule) await this.options.store.put(rule)
    else await this.options.store.remove(id)
    if (rule) {
      this.rules.set(id, rule)
      this.safe.delete(id)
    } else {
      this.rules.delete(id)
      this.safe.delete(id)
    }
    this.options.onChange?.()
  }

  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    const rule = this.rules.get(id)
    if (!rule || rule.status === status) return
    // Re-arming starts the safe-tick latch over, so a level the market has
    // already passed cannot fire the moment it is switched back on.
    if (status === "ARMED") this.safe.delete(id)
    const updated: StopRule = { ...rule, status, updatedAt: this.feed.now() }
    this.rules.set(id, updated)
    await this.persist(updated)
    this.options.onChange?.()
  }

  /**
   * Closes out a trigger. A whole-position exit stands sibling levels down to
   * avoid duplicate closes; a partial exit leaves them armed for the contracts
   * that remain. A cancelled trigger is left on hold for the trader to review.
   */
  async resolveTrigger(
    id: string,
    outcome: StopOutcome,
    submission?: StopExitSubmission,
  ): Promise<void> {
    const rule = this.rules.get(id)
    if (!rule) return
    const now = this.feed.now()
    if (outcome !== "SUBMITTED") {
      // Stood down, refused, or unknown. The rule stops watching either way:
      // left armed it would fire again immediately, and left triggered it would
      // sit doing nothing while still reading as a protected position.
      const stoodDown: StopRule = { ...rule, status: "PAUSED", updatedAt: now }
      this.rules.set(id, stoodDown)
      await this.persist(stoodDown)
      this.options.onChange?.()
      return
    }

    const done: StopRule = { ...rule, status: "DONE", exitOrderUid: submission?.orderUid ?? null, updatedAt: now }
    this.rules.set(id, done)
    await this.persist(done)
    const position = this.positions.get(rule.instrumentUid)
    const openQuantity = Math.abs(submission?.positionQuantity ?? position?.quantity ?? 0)
    const exitQuantity = submission?.quantity ?? (position ? stopRuleQuantity(rule, position) : null)
    const leavesOpenPosition = exitQuantity !== null && exitQuantity < openQuantity
    if (leavesOpenPosition) {
      this.options.onChange?.()
      return
    }
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
    if (sample.lastPrice !== undefined && this.feed.quoteState(rule.symbol, now) !== "live") return false

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
      priceAgeMs: this.feed.quoteAgeMs(rule.symbol, now),
    })
    return true
  }

  private async persist(rule: StopRule): Promise<void> {
    try {
      await this.options.store.put(rule)
    } catch (error) {
      this.feed.report(error)
    }
  }
}

// Re-exported so callers that already reach for the monitor keep one import.
export { rangeForInterval } from "@trbot/market/candle.ts"
