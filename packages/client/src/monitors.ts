import type { PriceAlert, PriceAlertDraft, PriceAlertStatus } from "@trbot/market/alert.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { StopRule, StopRuleDraft, StopRuleStatus } from "@trbot/trading/stop.ts"
import type { HttpClient } from "./http.ts"

/**
 * Editing the rules the server evaluates.
 *
 * A client sends the draft and the server creates the rule, so the identifier
 * and the timestamps come from the process that will act on it. It also means
 * the write reaches the running monitor rather than only the database: a rule
 * stored without the monitor being told is a rule that never fires.
 */
export type StopDecision = "confirm" | "cancel" | "hold" | "release"

export interface StopRuleClient {
  list(): Promise<StopRule[]>
  save(draft: StopRuleDraft): Promise<StopRule>
  remove(id: string): Promise<void>
  setStatus(id: string, status: StopRuleStatus): Promise<void>
  /**
   * Answers a fired stop and waits to be told it landed. A decision the server
   * never received is one the trader believes was made.
   */
  decide(id: string, decision: StopDecision): Promise<void>
}

export interface AlertClient {
  list(): Promise<PriceAlert[]>
  save(draft: PriceAlertDraft): Promise<PriceAlert>
  remove(id: string): Promise<void>
  setStatus(id: string, status: PriceAlertStatus): Promise<void>
}

export class HttpStopRules implements StopRuleClient {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<StopRule[]> {
    return this.http.get<StopRule[]>(ROUTES.stops)
  }

  save(draft: StopRuleDraft): Promise<StopRule> {
    return this.http.put<StopRule>(ROUTES.stops, { body: draft })
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(ROUTES.stop(id))
  }

  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    await this.http.put(ROUTES.stopStatus(id), { body: { status } })
  }

  async decide(id: string, decision: StopDecision): Promise<void> {
    await this.http.post(ROUTES.stopDecision(id), { body: { decision } })
  }
}

export class HttpAlerts implements AlertClient {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<PriceAlert[]> {
    return this.http.get<PriceAlert[]>(ROUTES.alerts)
  }

  save(draft: PriceAlertDraft): Promise<PriceAlert> {
    return this.http.put<PriceAlert>(ROUTES.alerts, { body: draft })
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(ROUTES.alert(id))
  }

  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    await this.http.put(ROUTES.alertStatus(id), { body: { status } })
  }
}
