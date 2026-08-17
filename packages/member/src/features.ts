// Paid entitlements the signed-in member holds. These are subscription tier
// features, not application settings: the provider decides them per member and
// the app can only read them.
export type MemberFeature =
  | "MARKET_DEPTH"
  | "BROKERAGE_DISTRIBUTION"
  | "SETTLEMENT_ANALYSIS"
  | "SUBSCRIPTION"

export interface MemberFeatureSet {
  has(feature: MemberFeature): boolean
}

export interface MemberFeatureSource {
  loadFeatures(options?: { signal?: AbortSignal }): Promise<MemberFeatureSet>
}

export function memberFeatureSet(features: Iterable<MemberFeature>): MemberFeatureSet {
  const enabled = new Set(features)
  return { has: (feature) => enabled.has(feature) }
}

export const NO_MEMBER_FEATURES: MemberFeatureSet = memberFeatureSet([])
