import { PriceAlertSchema, type PriceAlert, type PriceAlertActions, type PriceAlertDraft, type PriceAlertStatus } from "@trbot/market/alert.ts"
import { MarketMonitorSchema, type MarketMonitor } from "@trbot/market/market-monitor.ts"
import { OkResponseSchema, ROUTES } from "@trbot/protocol/routes.ts"
import { StopRuleSchema, type StopRule, type StopRuleDraft, type StopRuleStatus } from "@trbot/trading/stop.ts"
import type { HttpClient } from "./http.ts"
import { z } from "zod"

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

export type AlertClient = PriceAlertActions

export interface MarketMonitorClient {
  list(chatSessionId: string): Promise<MarketMonitor[]>
  remove(id: string): Promise<void>
}

export class HttpStopRules implements StopRuleClient {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<StopRule[]> {
    return this.http.get(ROUTES.stops, z.array(StopRuleSchema))
  }

  save(draft: StopRuleDraft): Promise<StopRule> {
    return this.http.put(ROUTES.stops, StopRuleSchema, { body: draft })
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(ROUTES.stop(id), z.array(StopRuleSchema))
  }

  async setStatus(id: string, status: StopRuleStatus): Promise<void> {
    await this.http.put(ROUTES.stopStatus(id), z.array(StopRuleSchema), { body: { status } })
  }

  async decide(id: string, decision: StopDecision): Promise<void> {
    await this.http.post(ROUTES.stopDecision(id), OkResponseSchema, { body: { decision } })
  }
}

export class HttpAlerts implements AlertClient {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<PriceAlert[]> {
    return this.http.get(ROUTES.alerts, z.array(PriceAlertSchema))
  }

  save(draft: PriceAlertDraft): Promise<PriceAlert> {
    return this.http.put(ROUTES.alerts, PriceAlertSchema, { body: draft })
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(ROUTES.alert(id), z.array(PriceAlertSchema))
  }

  async setStatus(id: string, status: PriceAlertStatus): Promise<void> {
    await this.http.put(ROUTES.alertStatus(id), z.array(PriceAlertSchema), { body: { status } })
  }
}

export class HttpMarketMonitors implements MarketMonitorClient {
  constructor(private readonly http: HttpClient) {}

  list(chatSessionId: string): Promise<MarketMonitor[]> {
    const query = new URLSearchParams({ chatSessionId })
    return this.http.get(`${ROUTES.marketMonitors}?${query}`, z.array(MarketMonitorSchema))
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(ROUTES.marketMonitor(id), OkResponseSchema)
  }
}
