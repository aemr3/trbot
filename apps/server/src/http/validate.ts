import {
  UserPriceAlertDraftSchema,
  validatePriceAlert,
  type PriceAlertDraft,
} from "@trbot/market/alert.ts"
import {
  AiModelChoiceSchema,
  AiPreferencesSchema,
  type AiModelChoice,
  type AiPreferences,
} from "@trbot/protocol/ai.ts"
import {
  StopRuleDraftSchema,
  validateStopRule,
  type StopRuleDraft,
} from "@trbot/trading/stop.ts"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  isCandleChartTarget,
  isCandleInterval,
  isCandleRange,
  type CandleChartTarget,
  type CandleInterval,
  type CandleRange,
} from "@trbot/market/candle.ts"
import {
  AppPreferencesSchema,
  normalizeAppPreferences,
  type AppPreferences,
} from "@trbot/preferences/app.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { isPortfolioRange, type PortfolioRange } from "@trbot/trading/account.ts"
import type { JsonObject } from "./request.ts"
import { z, type ZodType } from "zod"

const RequestValueSchema = z.preprocess((value) => value, z.json())

function invalid(field: string, detail: string): ProtocolError {
  return new ProtocolError("invalid_request", `"${field}" ${detail}`)
}

function invalidSchema(
  error: { issues: readonly { path: readonly PropertyKey[] }[] },
  fallbackField: string,
  detail: string,
): ProtocolError {
  const path = error.issues[0]?.path.map(String).join(".")
  return invalid(path || fallbackField, detail)
}

export function payload<T>(value: z.input<typeof RequestValueSchema>, schema: ZodType<T>, name = "request"): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalidSchema(parsed.error, name, "is not valid")
  return parsed.data
}

export function portfolioRange(value: string | null): PortfolioRange | undefined {
  if (value === null) return undefined
  if (!isPortfolioRange(value)) throw invalid("portfolioRange", "is not a known range")
  return value
}

export function chartTarget(value: string | null): CandleChartTarget | undefined {
  if (value === null) return undefined
  if (!isCandleChartTarget(value)) throw invalid("target", "is not a known chart target")
  return value
}

export interface CandleSelection {
  range: CandleRange
  interval: CandleInterval
}

/**
 * Candle requests carry a range and an interval that must go together — the
 * provider rejects a mismatched pair, so it is caught here with a clearer
 * message than the upstream one.
 */
export function candleSelection(rangeValue: string | null, intervalValue: string | null): CandleSelection {
  if (!rangeValue || !isCandleRange(rangeValue)) throw invalid("range", "is not a known candle range")
  if (!intervalValue || !isCandleInterval(intervalValue)) throw invalid("interval", "is not a known candle interval")
  if (!DEFAULT_INTERVALS_BY_RANGE[rangeValue].includes(intervalValue)) {
    throw invalid("interval", `is not available for the ${rangeValue} range`)
  }
  return { range: rangeValue, interval: intervalValue }
}

/**
 * The check the editor runs, run again here.
 *
 * Types alone let through rules that are well formed and still unusable: a
 * fractional quantity, a close-based rule with no timeframe, an ATR rule with no
 * ATR. Those persist as armed and then never fire, or fail only at the moment
 * they try to exit. The editor is not the place to enforce it, because the
 * editor is not the only thing that can reach this route.
 *
 * The market price is deliberately not supplied: whether a level sits on the
 * far side of the market is a question about what the trader is looking at, and
 * the server would be answering it from a different tick.
 */
function checkDraft(problem: string | null): void {
  if (problem !== null) throw new ProtocolError("invalid_request", problem)
}

/**
 * A rule the trader wants armed.
 *
 * Drafts are checked rather than trusted: an unchecked one becomes a live rule
 * that can send an exit order, and the server creates the identifier and the
 * timestamps itself so its own clock decides when a rule was made.
 */
export function stopRuleDraft(body: JsonObject): StopRuleDraft {
  const parsed = StopRuleDraftSchema.safeParse(body)
  if (!parsed.success) throw invalidSchema(parsed.error, "rule", "is not a valid stop rule")
  const draft = parsed.data
  checkDraft(validateStopRule(draft, null))
  return draft
}

export function priceAlertDraft(body: JsonObject): PriceAlertDraft {
  const parsed = UserPriceAlertDraftSchema.safeParse(body)
  if (!parsed.success) throw invalidSchema(parsed.error, "alert", "is not a valid price alert")
  const draft = parsed.data
  checkDraft(validatePriceAlert(draft, null))
  return draft
}

/**
 * Checked on the way in rather than only on the way out. The store falls back to
 * defaults when it reads something it does not recognise, so an unchecked write
 * would not fail — it would quietly reset the trader's settings on next launch.
 */
export function appPreferences(body: JsonObject): AppPreferences {
  const parsed = AppPreferencesSchema.safeParse(body)
  if (!parsed.success) {
    throw invalidSchema(parsed.error, "preferences", "is not a valid preferences payload")
  }
  return normalizeAppPreferences(parsed.data)
}

/** Which model answers. The ids stay free-form: they are the harness's vocabulary. */
export function aiModelChoice(body: JsonObject): AiModelChoice {
  const parsed = AiModelChoiceSchema.safeParse({ ...body, reasoning: body.reasoning ?? null })
  if (!parsed.success) throw invalidSchema(parsed.error, "model", "is not a valid model choice")
  return parsed.data
}

/**
 * The default chat model, which may be unset.
 *
 * Null is a real value here — it is how a trader clears a choice — so it is accepted
 * rather than treated as a missing field.
 */
export function aiPreferences(body: JsonObject): AiPreferences {
  const parsed = AiPreferencesSchema.safeParse({
    chat: body.chat ?? null,
  })
  if (!parsed.success) {
    throw invalidSchema(parsed.error, "preferences", "is not a valid AI preferences payload")
  }
  return parsed.data
}
