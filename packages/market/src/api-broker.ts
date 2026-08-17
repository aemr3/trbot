import type { ApiClient } from "@trbot/api"
import { marketOperations, type BrokerageCalendarPreset } from "@trbot/api/market.ts"
import type { BrokerageDatePreset } from "./broker-calendar.ts"

type BrokerApiClient = Pick<ApiClient, "call">

// Presets the provider marks as needing its own calendar UI carry no dates of
// their own; the panel offers the day list instead, so they are dropped here.
const SELECTABLE_PRESET_ACTION = "SELECT"

// What the trade-flow distribution and the settlement register both need at the
// API boundary: the underlying stock behind a contract, and the provider's date
// presets in the app's own shape.

// The broker-house feeds only report on cash equities, so a VIOP contract's uid
// has to be traded for its underlying stock's before either can be read. The
// pairing never changes, so it is cached for the life of the session.
export class UnderlyingUidResolver {
  private readonly uids = new Map<string, string>()

  constructor(private readonly client: BrokerApiClient) {}

  async resolve(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const cached = this.uids.get(instrumentUid)
    if (cached) return cached
    const data = await this.client.call(marketOperations.getInstrument, { instrumentId: instrumentUid }, { signal })
    // A uid that already belongs to an equity has no underlying of its own.
    const underlyingUid = data.instrument?.underlyingInstrumentUid ?? instrumentUid
    this.uids.set(instrumentUid, underlyingUid)
    return underlyingUid
  }
}

export function toDatePresets(presets: BrokerageCalendarPreset[]): BrokerageDatePreset[] {
  return presets.filter((preset) => preset.action === SELECTABLE_PRESET_ACTION).map((preset) => ({
    // The default preset is the live session, which the provider also serves
    // for a null range; keeping it null avoids re-querying at each rollover.
    range: preset.isDefault ? { start: null, end: null } : { start: preset.start, end: preset.end },
    isDefault: preset.isDefault,
  }))
}
