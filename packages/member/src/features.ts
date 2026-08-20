import { z } from "zod"

// Paid entitlements the signed-in member holds. These are subscription tier
// features, not application settings: the provider decides them per member and
// the app can only read them.
const MEMBER_FEATURES = [
  "MARKET_DEPTH",
  "BROKERAGE_DISTRIBUTION",
  "SETTLEMENT_ANALYSIS",
  "SUBSCRIPTION",
] as const

export type MemberFeature = (typeof MEMBER_FEATURES)[number]
export const MemberFeatureSchema = z.enum(MEMBER_FEATURES)

/**
 * What the member is entitled to.
 *
 * `list` is not a convenience: a set that only answers `has` cannot survive
 * being sent to a client, because the answer lives in a closure that does not
 * serialize. Anything crossing a process boundary is rebuilt from `list`.
 */
export interface MemberFeatureSet {
  has(feature: MemberFeature): boolean
  list(): MemberFeature[]
}

export interface MemberFeatureSource {
  loadFeatures(options?: { signal?: AbortSignal }): Promise<MemberFeatureSet>
}

export function memberFeatureSet(features: Iterable<MemberFeature>): MemberFeatureSet {
  const enabled = new Set(features)
  return {
    has: (feature) => enabled.has(feature),
    list: () => MEMBER_FEATURES.filter((feature) => enabled.has(feature)),
  }
}

export function isMemberFeature(value: unknown): value is MemberFeature {
  return typeof value === "string" && MEMBER_FEATURES.some((feature) => feature === value)
}
