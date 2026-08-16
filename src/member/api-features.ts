import type { ApiClient } from "../api/index.ts"
import { memberOperations } from "../api/member.ts"
import { memberFeatureSet, type MemberFeature, type MemberFeatureSet, type MemberFeatureSource } from "./features.ts"

type MemberApiClient = Pick<ApiClient, "call" | "authenticate">

// The provider names its flags after the market they were launched in
// (`TR_DEPTH`) and after its own subscription brand (`MIDAS_PRO`). Only this
// boundary knows those names; the rest of the app uses the neutral ones.
const FEATURE_BY_PROVIDER_NAME: Record<string, MemberFeature> = {
  TR_DEPTH: "MARKET_DEPTH",
  INSTANT_BROKERAGE_DISTRIBUTION: "BROKERAGE_DISTRIBUTION",
  SETTLEMENT: "SETTLEMENT_ANALYSIS",
  MIDAS_PRO: "SUBSCRIPTION",
}

export class ApiMemberFeatureSource implements MemberFeatureSource {
  constructor(private readonly client: MemberApiClient) {}

  async loadFeatures(options: { signal?: AbortSignal } = {}): Promise<MemberFeatureSet> {
    const session = await this.client.authenticate()
    const data = await this.client.call(
      memberOperations.memberFeatures,
      { memberUid: session.memberUid },
      { signal: options.signal },
    )
    const enabled = (data.memberFeatures ?? []).flatMap((flag): MemberFeature[] => {
      const feature = FEATURE_BY_PROVIDER_NAME[flag.featureName]
      return feature && flag.enabled ? [feature] : []
    })
    return memberFeatureSet(enabled)
  }
}
