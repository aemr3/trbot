import type { ApiClient } from "../api/index.ts"
import { marketOperations, type BrokerageCalendarPreset } from "../api/market.ts"
import type {
  BrokerageDatePreset,
  BrokerageDistribution,
  BrokerageDistributionRequest,
  BrokerageDistributionSource,
} from "./brokerage.ts"

type BrokerageApiClient = Pick<ApiClient, "call">

// Presets the provider marks as needing its own calendar UI carry no dates of
// their own; the panel offers the day list instead, so they are dropped here.
const SELECTABLE_PRESET_ACTION = "SELECT"

// Reads the brokerage distribution for the stock behind a VIOP contract. The
// provider only reports on cash equities, so the contract's uid is resolved to
// its underlying first and the mapping cached for the session.
export class ApiBrokerageDistributionSource implements BrokerageDistributionSource {
  private readonly underlyingUids = new Map<string, string>()

  constructor(private readonly client: BrokerageApiClient) {}

  async loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    const { instrumentUid, side, range, signal } = request
    const uid = await this.resolveUnderlyingUid(instrumentUid, signal)
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
      presets: distribution.calendar.presets.filter(isSelectable).map(toPreset),
      availableDates: distribution.calendar.dateSet,
    }
  }

  private async resolveUnderlyingUid(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const cached = this.underlyingUids.get(instrumentUid)
    if (cached) return cached
    const data = await this.client.call(marketOperations.getInstrument, { instrumentId: instrumentUid }, { signal })
    const underlyingUid = data.instrument?.underlyingInstrumentUid ?? instrumentUid
    this.underlyingUids.set(instrumentUid, underlyingUid)
    return underlyingUid
  }
}

function isSelectable(preset: BrokerageCalendarPreset): boolean {
  return preset.action === SELECTABLE_PRESET_ACTION
}

function toPreset(preset: BrokerageCalendarPreset): BrokerageDatePreset {
  return {
    // The default preset is the live session, which the provider also serves
    // for a null range; keeping it null avoids re-querying at each rollover.
    range: preset.isDefault ? { start: null, end: null } : { start: preset.start, end: preset.end },
    isDefault: preset.isDefault,
  }
}
