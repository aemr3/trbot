import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { StopOutcome } from "@trbot/protocol/stream.ts"
import type { AccountPosition } from "@trbot/trading/account.ts"
import { StopMonitor, type StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"
import type { StopRule, StopRuleDraft, StopRuleStatus, StopRuleStore } from "@trbot/trading/stop.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { ViopPositionExitSource } from "@trbot/trading/order.ts"

/** Matches the confirmation window the terminal used to run locally. */
const DEFAULT_COUNTDOWN_MS = 10_000

// A stop that fires while the session is being rebuilt waits for it rather than
// giving up: recovery takes seconds, and the position is unprotected until then.
const SUBMIT_RETRY_MS = 2_000
const MAX_SUBMIT_ATTEMPTS = 15

export interface StopControllerOptions {
  store: StopRuleStore
  candles?: CandleSource
  /** Resolved lazily, because a session can be replaced by a re-login. */
  exits: () => ViopPositionExitSource | null
  /**
   * Whether a failed exit definitely never reached the provider. Injected so the
   * domain controller does not have to know about provider error types.
   */
  isDefiniteRefusal?: (error: unknown) => boolean
  broadcast: (event: StopControllerEvent) => void
  countdownMs?: number
  /** How long to wait before retrying an exit that found no session. */
  submitRetryMs?: number
  maxSubmitAttempts?: number
  onError?: (error: unknown) => void
  now?: () => number
}

export type StopControllerEvent =
  | { type: "triggered"; event: StopTriggerEvent; remainingMs: number; held: boolean }
  | { type: "resolved"; ruleId: string; outcome: StopOutcome }
  | { type: "changed" }

interface PendingStop {
  event: StopTriggerEvent
  deadline: number
  held: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Submissions that found no provider session; see submit. */
  attempts: number
}

/**
 * Runs stop rules on the server and owns the countdown that follows a trigger.
 *
 * The countdown is a dead man's switch, matching the behaviour the terminal had:
 * once a rule fires, the exit goes out when the countdown expires unless a
 * client cancels or holds it. That is what lets an unattended server still
 * protect a position — but it also means a trigger with no client attached will
 * submit an order.
 */
export class StopController {
  private readonly monitor: StopMonitor
  private readonly pending = new Map<string, PendingStop>()
  private readonly countdownMs: number
  private readonly submitRetryMs: number
  private readonly maxSubmitAttempts: number
  private readonly now: () => number

  constructor(private readonly options: StopControllerOptions) {
    this.countdownMs = options.countdownMs ?? DEFAULT_COUNTDOWN_MS
    this.submitRetryMs = options.submitRetryMs ?? SUBMIT_RETRY_MS
    this.maxSubmitAttempts = options.maxSubmitAttempts ?? MAX_SUBMIT_ATTEMPTS
    this.now = options.now ?? Date.now
    this.monitor = new StopMonitor({
      store: options.store,
      candles: options.candles,
      onTrigger: (event) => this.onTrigger(event),
      onChange: () => options.broadcast({ type: "changed" }),
      onError: (error) => options.onError?.(error),
      now: this.now,
    })
  }

  get rules() {
    return this.monitor
  }

  symbols(): string[] {
    return this.monitor.symbols()
  }

  /**
   * Editing goes through here rather than through the store.
   *
   * The monitor keeps the armed rules in memory and only learns of a change by
   * being told: a write that reaches the database behind its back is a rule that
   * is saved but never watched, which is the worst way for a stop to fail.
   */
  list(): StopRule[] {
    return this.monitor.views().map((view) => view.rule)
  }

  async save(draft: StopRuleDraft): Promise<StopRule> {
    const rule = await this.monitor.saveRule(draft)
    // A close-based rule has no ticks to fall back on, so until its candles are
    // read it shows no level at all. Reading now rather than waiting out the
    // poll is the difference between a rule that looks armed and one that looks
    // broken. Not awaited: the rule is saved either way.
    void this.monitor.refreshCandleRules().catch((error: unknown) => this.options.onError?.(error))
    return rule
  }

  async remove(id: string): Promise<void> {
    // A deleted rule must not be able to send its exit, so any countdown it had
    // running dies with it.
    this.abandon(id)
    await this.monitor.removeRule(id)
  }

  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    if (status !== "TRIGGERED") this.abandon(id)
    await this.monitor.setStatus(id, status)
  }

  applyQuote(update: QuoteUpdate): void {
    this.monitor.applyQuote(update)
    const stop = this.pending.get(keyForSymbol(this.pending, update.symbol))
    if (stop) this.republish(stop)
  }

  setPositions(positions: AccountPosition[]): void {
    this.monitor.setPositions(positions)
  }

  /** Anything currently counting down, so a client that connects mid-flight sees it. */
  outstanding(): StopControllerEvent[] {
    return [...this.pending.values()].map((stop) => ({
      type: "triggered" as const,
      event: stop.event,
      remainingMs: Math.max(0, stop.deadline - this.now()),
      held: stop.held,
    }))
  }

  decide(ruleId: string, decision: "confirm" | "cancel" | "hold" | "release"): void {
    const stop = this.pending.get(ruleId)
    if (!stop) return

    if (decision === "confirm") {
      this.clearTimer(stop)
      void this.submit(stop)
      return
    }
    if (decision === "cancel") {
      this.clearTimer(stop)
      this.pending.delete(ruleId)
      void this.monitor.resolveTrigger(ruleId, "CANCELLED")
      this.options.broadcast({ type: "resolved", ruleId, outcome: "CANCELLED" })
      return
    }
    if (decision === "hold") {
      stop.held = true
      this.clearTimer(stop)
      this.republish(stop)
      return
    }
    // release
    stop.held = false
    stop.deadline = this.now() + this.countdownMs
    this.arm(stop)
    this.republish(stop)
  }

  destroy(): void {
    for (const stop of this.pending.values()) this.clearTimer(stop)
    this.pending.clear()
    this.monitor.destroy()
  }

  /** Drops a countdown without sending its exit, for a rule that is going away. */
  private abandon(ruleId: string): void {
    const stop = this.pending.get(ruleId)
    if (!stop) return
    this.clearTimer(stop)
    this.pending.delete(ruleId)
    this.options.broadcast({ type: "resolved", ruleId, outcome: "CANCELLED" })
  }

  private onTrigger(event: StopTriggerEvent): void {
    if (this.pending.has(event.rule.id)) return
    const stop: PendingStop = {
      event,
      deadline: this.now() + this.countdownMs,
      held: false,
      timer: null,
      attempts: 0,
    }
    this.pending.set(event.rule.id, stop)
    this.arm(stop)
    this.republish(stop)
  }

  private arm(stop: PendingStop): void {
    this.clearTimer(stop)
    stop.timer = setTimeout(() => void this.submit(stop), Math.max(0, stop.deadline - this.now()))
  }

  private clearTimer(stop: PendingStop): void {
    if (stop.timer) clearTimeout(stop.timer)
    stop.timer = null
  }

  private republish(stop: PendingStop): void {
    this.options.broadcast({
      type: "triggered",
      event: stop.event,
      remainingMs: Math.max(0, stop.deadline - this.now()),
      held: stop.held,
    })
  }

  private async submit(stop: PendingStop): Promise<void> {
    const ruleId = stop.event.rule.id
    if (!this.pending.has(ruleId)) return
    this.clearTimer(stop)

    const exits = this.options.exits()
    if (!exits) {
      // Almost always a session being rebuilt, which takes seconds. Giving up
      // here would leave the rule triggered with nothing pending behind it —
      // the position unprotected, and nothing left to say so.
      if (stop.attempts < this.maxSubmitAttempts) {
        stop.attempts += 1
        stop.timer = setTimeout(() => void this.submit(stop), this.submitRetryMs)
        return
      }
      this.pending.delete(ruleId)
      this.options.onError?.(new Error(`No provider session; the ${stop.event.rule.displayName} exit was not sent`))
      // Stood down as well as reported: a rule left triggered watches nothing
      // and still reads as a protected position.
      await this.monitor.resolveTrigger(ruleId, "FAILED").catch((error: unknown) => this.options.onError?.(error))
      this.options.broadcast({ type: "resolved", ruleId, outcome: "FAILED" })
      return
    }

    // Past here the order may reach the provider, so the stop stops being
    // pending: a second timer must not be able to send it again.
    this.pending.delete(ruleId)

    let orderUid: string
    try {
      orderUid = (
        await exits.exitPosition({
          instrumentUid: stop.event.rule.instrumentUid,
          quantity: stop.event.quantity,
        })
      ).orderUid
    } catch (error) {
      this.options.onError?.(error)
      // A refusal means nothing was sent. Anything else — a dropped connection,
      // a timeout — means an exit may be live, and saying "failed" would tell a
      // trader their position is still open when it may not be.
      const outcome = this.options.isDefiniteRefusal?.(error) === false ? "UNKNOWN" : "FAILED"
      await this.monitor.resolveTrigger(ruleId, outcome).catch((caught: unknown) => this.options.onError?.(caught))
      this.options.broadcast({ type: "resolved", ruleId, outcome })
      return
    }

    // The exit is at the provider. Recording it can still fail, and that is a
    // bookkeeping problem, not a trading one — reporting it as a failed exit
    // would be the one wrong answer.
    await this.monitor
      .resolveTrigger(ruleId, "SUBMITTED", orderUid)
      .catch((error: unknown) => this.options.onError?.(error))
    this.options.broadcast({ type: "resolved", ruleId, outcome: "SUBMITTED" })
  }
}

function keyForSymbol(pending: Map<string, PendingStop>, symbol: string): string {
  for (const [id, stop] of pending) {
    if (stop.event.rule.symbol === symbol) return id
  }
  return ""
}
