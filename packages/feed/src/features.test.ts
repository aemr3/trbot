import { describe, expect, test } from "bun:test"
import { memberFeatureSet, type MemberFeature, type MemberFeatureSource } from "@trbot/member/features.ts"
import { FeedMemberFeatureSource } from "./features.ts"
import type { FeedEntitlements } from "./session.ts"

function entitlements(granted: Partial<FeedEntitlements>): FeedEntitlements {
  return { realtimePrices: false, depth: false, distribution: false, settlement: false, subjects: [], ...granted }
}

function brokerageFeatures(features: MemberFeature[]): MemberFeatureSource {
  return { async loadFeatures() { return memberFeatureSet(features) } }
}

const FAILING: MemberFeatureSource = {
  async loadFeatures() { throw new Error("brokerage session expired") },
}

function build(feed: Partial<FeedEntitlements>, brokerage: MemberFeatureSource) {
  const errors: unknown[] = []
  return {
    errors,
    subject: new FeedMemberFeatureSource(
      { async loadEntitlements() { return entitlements(feed) } },
      { brokerage, onError: (cause) => errors.push(cause) },
    ),
  }
}

describe("FeedMemberFeatureSource", () => {
  test("lets the feed answer for the data it serves", async () => {
    const { subject } = build({ depth: true, distribution: true, settlement: true }, brokerageFeatures([]))
    const features = await subject.loadFeatures()

    expect(features.list()).toEqual(["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION", "SETTLEMENT_ANALYSIS"])
  })

  /**
   * The failure this exists to prevent: a brokerage tier that never included
   * depth blanking a panel the market data account pays for.
   */
  test("ignores the brokerage's view of the data it no longer serves", async () => {
    const { subject } = build({ depth: true }, brokerageFeatures(["BROKERAGE_DISTRIBUTION", "SETTLEMENT_ANALYSIS"]))
    const features = await subject.loadFeatures()

    expect(features.has("MARKET_DEPTH")).toBeTrue()
    expect(features.has("BROKERAGE_DISTRIBUTION")).toBeFalse()
    expect(features.has("SETTLEMENT_ANALYSIS")).toBeFalse()
  })

  test("still reads the features the feed does not answer for", async () => {
    const { subject } = build({}, brokerageFeatures(["SUBSCRIPTION"]))

    expect((await subject.loadFeatures()).has("SUBSCRIPTION")).toBeTrue()
  })

  // The whole point of splitting them: a brokerage that is down must not take
  // the feed-backed panels with it.
  test("keeps the feed's answer when the brokerage read fails", async () => {
    const { subject, errors } = build({ depth: true, distribution: true, settlement: true }, FAILING)
    const features = await subject.loadFeatures()

    expect(features.has("MARKET_DEPTH")).toBeTrue()
    expect(features.has("SUBSCRIPTION")).toBeFalse()
    expect(errors).toHaveLength(1)
  })

  test("reports a cancelled read as cancelled rather than as an absent feature", async () => {
    const { subject, errors } = build({ depth: true }, FAILING)
    const aborted = AbortSignal.abort()

    await expect(subject.loadFeatures({ signal: aborted })).rejects.toThrow("brokerage session expired")
    expect(errors).toBeEmpty()
  })
})
