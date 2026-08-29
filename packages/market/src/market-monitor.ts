import {
  PriceAlertSchema,
  createPriceAlert,
  type PriceAlert,
  type PriceAlertDraft,
  type PriceAlertStatus,
} from "./alert.ts"
import { z } from "zod"

/**
 * A durable condition owned by one chat agent.
 *
 * It shares price-condition mechanics with alerts, but not identity, storage, or
 * presentation. Every trigger resumes its owning chat with the stored continuation.
 */
export interface MarketMonitor extends PriceAlert {
  chatSessionId: string
  onTrigger: string
}

export interface MarketMonitorDraft extends PriceAlertDraft {
  chatSessionId: string
  onTrigger: string
}

const RequiredTextSchema = z.string().refine((value) => value.trim().length > 0)

export const MarketMonitorSchema: z.ZodType<MarketMonitor> = z.intersection(
  PriceAlertSchema,
  z.object({
    chatSessionId: RequiredTextSchema,
    onTrigger: RequiredTextSchema,
  }),
)

export interface MarketMonitorStore {
  list(): Promise<MarketMonitor[]>
  put(monitor: MarketMonitor): Promise<void>
  remove(id: string): Promise<void>
}

export interface MarketMonitorActions {
  list(): Promise<MarketMonitor[]>
  save(draft: MarketMonitorDraft): Promise<MarketMonitor>
  setStatus(id: string, status: PriceAlertStatus): Promise<void>
  remove(id: string): Promise<void>
}

export function createMarketMonitor(draft: MarketMonitorDraft, now: number): MarketMonitor {
  return {
    ...createPriceAlert(draft, now),
    chatSessionId: draft.chatSessionId,
    onTrigger: draft.onTrigger,
  }
}
