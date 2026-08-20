import { z } from "zod"
import { VIOP_ORDER_KINDS } from "./order.ts"

/** Persisted authority attached to unattended agent work. */
export const ExecutionPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ANALYSIS_ONLY") }),
  z.object({ mode: z.literal("CONFIRM_EACH_ORDER") }),
  z.object({
    mode: z.literal("AUTONOMOUS"),
    symbols: z.array(z.string().min(1)).min(1),
    maxContractsPerOrder: z.number().int().positive(),
    maxPositionSize: z.number().int().positive(),
    maxDailyLoss: z.number().positive(),
    allowedOrderTypes: z.array(z.enum(VIOP_ORDER_KINDS)).min(1),
    expiresAt: z.number().int().positive(),
  }),
])

export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>

export const ANALYSIS_ONLY_POLICY: ExecutionPolicy = { mode: "ANALYSIS_ONLY" }
