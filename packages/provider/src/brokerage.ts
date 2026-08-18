import type { ApiClient } from "@trbot/api"
import { marketOperations } from "@trbot/api/market.ts"
import { toDatePresets, UnderlyingUidResolver } from "./broker.ts"
import type {
  BrokerageDistribution,
  BrokerageDistributionRequest,
  BrokerageDistributionSource,
} from "@trbot/market/brokerage.ts"

type BrokerageApiClient = Pick<ApiClient, "call">

// Reads the brokerage distribution for the stock behind a VIOP contract.
export class ApiBrokerageDistributionSource implements BrokerageDistributionSource {
  private readonly underlying: UnderlyingUidResolver

  constructor(private readonly client: BrokerageApiClient) {
    this.underlying = new UnderlyingUidResolver(client)
  }

  async loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    const { instrumentUid, side, range, signal } = request
    const uid = await this.underlying.resolve(instrumentUid, signal)
    const data = await this.client.call(
      marketOperations.brokerageDistribution,
      { uid, brokeragePosition: side, start: range.start, end: range.end },
      { signal },
    )
    const distribution = data.brokerageDistribution
    if (!distribution) {
      return {
        side,
        shares: [],
        topCount: 0,
        topPercentage: 0,
        topLots: 0,
        otherLots: 0,
        lastUpdate: null,
        live: false,
        presets: [],
        availableDates: [],
      }
    }

    return {
      side,
      shares: distribution.distribution.map((entry) => ({
        brokerage: entry.brokerage,
        netLots: entry.netShares,
        averagePrice: entry.cost,
        percentage: entry.percentage,
      })),
      topCount: distribution.topNSize,
      topPercentage: distribution.topNPercentage,
      topLots: distribution.topNShares,
      otherLots: distribution.otherShares,
      lastUpdate: distribution.lastUpdate,
      live: distribution.dynamic,
      presets: toDatePresets(distribution.calendar.presets),
      availableDates: distribution.calendar.dateSet,
    }
  }
}
