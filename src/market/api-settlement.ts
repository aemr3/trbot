import type { ApiClient } from "../api/index.ts"
import { marketOperations, type SettlementAnalysisType } from "../api/market.ts"
import { toDatePresets, UnderlyingUidResolver } from "./api-broker.ts"
import type {
  SettlementAnalysis,
  SettlementMode,
  SettlementRequest,
  SettlementSource,
} from "./settlement.ts"

type SettlementApiClient = Pick<ApiClient, "call">

// The provider names the register's three readings after the direction of the
// move rather than after what they show.
const PROVIDER_TYPE_BY_MODE: Record<SettlementMode, SettlementAnalysisType> = {
  HELD: "TOTAL",
  GAINED: "UP",
  LOST: "DOWN",
}

// Reads the settlement register for the stock behind a VIOP contract: what each
// brokerage house was left holding once the range's trades cleared.
export class ApiSettlementSource implements SettlementSource {
  private readonly underlying: UnderlyingUidResolver

  constructor(private readonly client: SettlementApiClient) {
    this.underlying = new UnderlyingUidResolver(client)
  }

  async loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis> {
    const { instrumentUid, mode, range, signal } = request
    const uid = await this.underlying.resolve(instrumentUid, signal)
    const data = await this.client.call(
      marketOperations.settlementAnalysis,
      { uid, settlementType: PROVIDER_TYPE_BY_MODE[mode], start: range.start, end: range.end },
      { signal },
    )
    const analysis = data.settlementAnalysis
    if (!analysis) {
      return {
        mode,
        holdings: [],
        topCount: 0,
        topPercentage: 0,
        topLots: 0,
        otherLots: 0,
        lastUpdate: null,
        live: false,
        presets: [],
        availableDates: [],
        unavailableMessage: null,
      }
    }

    return {
      mode,
      holdings: analysis.settlements.map((entry) => ({
        brokerage: entry.brokerage,
        percentage: entry.percentage ?? 0,
        percentageChange: entry.percentageChange,
        lotChange: entry.lotChange,
        totalLot: entry.totalLot,
      })),
      topCount: analysis.topNSize,
      topPercentage: analysis.topNPercentage,
      // The provider signs the shed lots; the mode already carries the
      // direction, so the headline keeps the magnitude alone.
      topLots: Math.abs(analysis.topNLotChange),
      otherLots: Math.abs(analysis.otherLotChange),
      lastUpdate: analysis.lastUpdate,
      live: analysis.dynamic,
      presets: toDatePresets(analysis.calendar.presets),
      availableDates: analysis.calendar.dateSet,
      unavailableMessage: analysis.lastDateErrorMessage,
    }
  }
}
