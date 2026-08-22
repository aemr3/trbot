import {
  memberFeatureSet,
  type MemberFeature,
  type MemberFeatureSet,
  type MemberFeatureSource,
} from "@trbot/member/features.ts"
import type { FeedSession } from "./session.ts"

/**
 * What the member may read, once the feed serves the market data.
 *
 * The panels ask one question — may I see this? — and the answer belongs to
 * whoever serves the data. Depth, the brokerage distribution and the custody
 * register all come from the feed now, so the feed's own permissions decide
 * those three; a brokerage subscription that does not include them no longer
 * blanks a panel the feed is happy to fill, and the reverse holds too.
 *
 * Everything else is still the brokerage's to answer, so the rest is read from
 * `brokerage`. A failure there costs only those features: it must not take the
 * feed-backed panels down with it, which is the coupling this removes.
 */

/** The features the market data account speaks for. */
const FEED_FEATURES: MemberFeature[] = ["MARKET_DEPTH", "BROKERAGE_DISTRIBUTION", "SETTLEMENT_ANALYSIS"]

export interface FeedMemberFeatureSourceOptions {
  /** Read for the features the feed does not answer for, such as the subscription. */
  brokerage: MemberFeatureSource
  onError?: (cause: unknown) => void
}

export class FeedMemberFeatureSource implements MemberFeatureSource {
  constructor(
    private readonly session: Pick<FeedSession, "loadEntitlements">,
    private readonly options: FeedMemberFeatureSourceOptions,
  ) {}

  async loadFeatures(options: { signal?: AbortSignal } = {}): Promise<MemberFeatureSet> {
    const entitlements = await this.session.loadEntitlements()
    const features: MemberFeature[] = []
    if (entitlements.depth) features.push("MARKET_DEPTH")
    if (entitlements.distribution) features.push("BROKERAGE_DISTRIBUTION")
    if (entitlements.settlement) features.push("SETTLEMENT_ANALYSIS")

    for (const feature of await this.brokerageFeatures(options.signal)) {
      if (!FEED_FEATURES.includes(feature)) features.push(feature)
    }
    return memberFeatureSet(features)
  }

  private async brokerageFeatures(signal?: AbortSignal): Promise<MemberFeature[]> {
    try {
      return (await this.options.brokerage.loadFeatures({ signal })).list()
    } catch (cause) {
      // A cancelled read is the caller's own doing, not a failure to report.
      if (signal?.aborted) throw cause
      this.options.onError?.(cause)
      return []
    }
  }
}
