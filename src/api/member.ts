import { defineOperation } from "./graphql.ts"

export interface MemberFeatureFlag {
  featureName: string
  enabled: boolean
}

export interface MemberFeaturesData {
  memberFeatures?: MemberFeatureFlag[] | null
}

export interface MemberFeaturesVariables {
  memberUid: string
  [key: string]: unknown
}

export const memberOperations = {
  memberFeatures: defineOperation<MemberFeaturesData, MemberFeaturesVariables>(
    "memberFeatures",
    "query",
    "query memberFeatures($memberUid: String!) { memberFeatures(memberUid: $memberUid) { featureName enabled } }",
  ),
} as const
