import type { AlertClient, StopRuleClient } from "@trbot/client/monitors.ts"
import type { MonitorClient } from "@trbot/client/stream.ts"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { AccountPosition } from "@trbot/trading/account.ts"
import type { AlertTriggerEvent, PriceAlertView } from "@trbot/market/alert-monitor.ts"
import type { PriceAlert, PriceAlertDraft, PriceAlertStatus } from "@trbot/market/alert.ts"
import type { StopOutcome } from "@trbot/protocol/stream.ts"
import type { StopRuleView, StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"
import type { StopRule, StopRuleDraft, StopRuleStatus } from "@trbot/trading/stop.ts"

/**
 * The terminal's view of the stop rules the server evaluates.
 *
 * It deliberately mirrors the shape of `StopMonitor` so the watchlist screen
 * reads the same way, but nothing here decides anything: levels are watched,
 * countdowns are run and exits are sent by the server, so a stop still protects
 * a position when no terminal is attached. Everything below either displays what
 * the server reported or forwards the trader's decision to it.
 */
export class RemoteStopRules {
  private cached: StopRuleView[] = []
  private readonly changeListeners: (() => void)[] = []
  private readonly triggerListeners: ((event: StopTriggerEvent, remainingMs: number, held: boolean) => void)[] = []
  private readonly resolvedListeners: ((ruleId: string, outcome: StopOutcome) => void)[] = []

  constructor(private readonly rules: StopRuleClient) {}

  /** Called by the app once the stream frames are being routed here. */
  acceptViews(views: StopRuleView[]): void {
    this.cached = views
    for (const listener of this.changeListeners) listener()
  }

  acceptTrigger(event: StopTriggerEvent, remainingMs: number, held: boolean): void {
    for (const listener of this.triggerListeners) listener(event, remainingMs, held)
  }

  acceptResolved(ruleId: string, outcome: StopOutcome): void {
    for (const listener of this.resolvedListeners) listener(ruleId, outcome)
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener)
  }

  onTrigger(listener: (event: StopTriggerEvent, remainingMs: number, held: boolean) => void): void {
    this.triggerListeners.push(listener)
  }

  onResolved(listener: (ruleId: string, outcome: StopOutcome) => void): void {
    this.resolvedListeners.push(listener)
  }

  // Views arrive on the stream, including a snapshot when the socket opens, so
  // there is nothing to fetch here.
  async load(): Promise<void> {}

  destroy(): void {
    this.changeListeners.length = 0
    this.triggerListeners.length = 0
    this.resolvedListeners.length = 0
  }

  views(): StopRuleView[] {
    return this.cached
  }

  rule(id: string): StopRule | undefined {
    return this.cached.find((view) => view.rule.id === id)?.rule
  }

  symbols(): string[] {
    return [...new Set(this.cached.map((view) => view.rule.symbol))]
  }

  // Prices, positions and candle-based levels are the server's concern. These
  // stay on the interface so the screen reads the same either way.
  setPositions(_positions: AccountPosition[]): void {}
  applyQuote(_update: QuoteUpdate): void {}
  async refreshCandleRules(): Promise<void> {}

  // Edits are sent as drafts. The server creates the rule and hands it to the
  // monitor that will watch it, so nothing here needs to know how a rule is
  // built — and nothing can save one the monitor never hears about.
  saveRule(draft: StopRuleDraft): Promise<StopRule> {
    return this.rules.save(draft)
  }

  removeRule(id: string): Promise<void> {
    return this.rules.remove(id)
  }

  setStatus(id: string, status: StopRuleStatus): Promise<void> {
    return this.rules.setStatus(id, status)
  }

  /**
   * Answering a fired stop goes over HTTP, not the socket, and the caller waits
   * for it.
   *
   * A socket frame is written into a queue. If the socket is down the server
   * never hears it, sends the exit when the countdown runs out, and the terminal
   * has already told the trader it stood the stop down — the worst possible
   * combination, because they stop watching. Only an acknowledgement can be
   * reported as a decision made.
   */
  confirm(id: string): Promise<void> {
    return this.rules.decide(id, "confirm")
  }

  /** Stands the stop down. The server sends nothing and marks the rule cancelled. */
  cancel(id: string): Promise<void> {
    return this.rules.decide(id, "cancel")
  }

  hold(id: string): Promise<void> {
    return this.rules.decide(id, "hold")
  }

  release(id: string): Promise<void> {
    return this.rules.decide(id, "release")
  }
}

/** The terminal's view of the price alerts the server evaluates. */
export class RemoteAlerts {
  private cached: PriceAlertView[] = []
  private readonly changeListeners: (() => void)[] = []
  private readonly triggerListeners: ((event: AlertTriggerEvent) => void)[] = []

  constructor(
    private readonly alerts: AlertClient,
    private readonly monitors: MonitorClient,
  ) {}

  acceptViews(views: PriceAlertView[]): void {
    this.cached = views
    for (const listener of this.changeListeners) listener()
  }

  acceptTrigger(event: AlertTriggerEvent): void {
    for (const listener of this.triggerListeners) listener(event)
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener)
  }

  onTrigger(listener: (event: AlertTriggerEvent) => void): void {
    this.triggerListeners.push(listener)
  }

  async load(): Promise<void> {}

  destroy(): void {
    this.changeListeners.length = 0
    this.triggerListeners.length = 0
  }

  views(): PriceAlertView[] {
    return this.cached
  }

  alert(id: string): PriceAlert | undefined {
    return this.cached.find((view) => view.alert.id === id)?.alert
  }

  symbols(): string[] {
    return [...new Set(this.cached.map((view) => view.alert.symbol))]
  }

  applyQuote(_update: QuoteUpdate): void {}
  async refreshCandleAlerts(): Promise<void> {}

  saveAlert(draft: PriceAlertDraft): Promise<PriceAlert> {
    return this.alerts.save(draft)
  }

  removeAlert(id: string): Promise<void> {
    return this.alerts.remove(id)
  }

  // The server clears the alert from what it is announcing as part of the same
  // change, so there is no separate decision to send here.
  setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    return this.alerts.setStatus(id, status)
  }

  dismiss(id: string): void {
    this.monitors.decideAlert(id, "dismiss")
  }
}
