import { defineOperation } from "./graphql.ts"

interface MemberFeatureFlag {
  featureName: string
  enabled: boolean
}

export interface MemberFeaturesData {
  memberFeatures?: MemberFeatureFlag[] | null
}

export interface MemberFeaturesVariables {
  memberUid: string
}

export const memberOperations = {
  memberFeatures: defineOperation<MemberFeaturesData, MemberFeaturesVariables>(
    "memberFeatures",
    "query",
    "query memberFeatures($memberUid: String!) { memberFeatures(memberUid: $memberUid) { featureName enabled } }",
  ),
} as const
