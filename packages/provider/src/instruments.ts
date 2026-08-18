import type { ApiClient } from "@trbot/api"
import {
  marketOperations,
  type ScreenerColumnInput,
  type ScreenerInstrument,
  type ScreenerResultV2Variables,
} from "@trbot/api/market.ts"
import type { ViopContractDetails, ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"

type MarketApiClient = Pick<ApiClient, "call">

const ASSET_VERTICAL = "TR"
const INVESTMENT_TYPE = "FUTURES"
const MAX_PAGES = 40
// Underlying types to exclude: currency-pair futures (PARITY, e.g. USDTRY/EURTRY)
// and index futures (Endeks, e.g. XU030/XLBNK; the provider also classes gold here).
// Only single-stock (Hisse) futures remain.
const EXCLUDED_UNDERLYING_TYPES = new Set(["PARITY", "Endeks"])

const COLUMNS: ScreenerColumnInput[] = [
  { id: "underlyingInstrumentSymbol", field: "underlying.symbol" },
  { id: "underlyingInstrumentType", field: "underlying.type" },
  { id: "price", field: "derivativePrice.price" },
  { id: "percentageChangeDay", field: "percentageChange.percentageChangeDay" },
  { id: "derivativeVolume", field: "stats.volume" },
  { id: "redemptionDate", field: "redemptionDate" },
]

export class ApiViopInstrumentSource implements ViopInstrumentSource {
  constructor(private readonly client: MarketApiClient) {}

  async listInstruments(options: { signal?: AbortSignal } = {}): Promise<ViopInstrument[]> {
    const { signal } = options
    const instruments: ScreenerInstrument[] = []
    const seen = new Set<string>()
    let pitId: string | null = null
    let searchAfter: string | null = null
    const sortBy = "stats.volume"
    const sortDirection = "DESC"

    for (let page = 0; page < MAX_PAGES; page++) {
      const variables: ScreenerResultV2Variables = {
        pitId,
        searchAfter,
        sortBy,
        sortDirection,
        assetVertical: ASSET_VERTICAL,
        investmentType: INVESTMENT_TYPE,
        filters: [],
        columns: COLUMNS,
      }
      const data = await this.client.call(marketOperations.screenerRetrieveResultV2, variables, { signal })
      const result = data.screenerRetrieveResultV2
      if (!result || result.instruments.length === 0) break

      for (const instrument of result.instruments) {
        if (seen.has(instrument.uid)) continue
        seen.add(instrument.uid)
        instruments.push(instrument)
      }

      pitId = result.pitId
      searchAfter = result.searchAfter
      if (!searchAfter || instruments.length >= result.totalSize) break
    }

    const tradable = instruments.filter((instrument) => !isExcludedContract(instrument))
    return frontMonthPerUnderlying(tradable).map(toInstrument)
  }

  async loadContractDetails(
    instrumentUid: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ViopContractDetails> {
    const data = await this.client.call(
      marketOperations.futureDetail,
      { instrumentUid },
      { signal: options.signal },
    )
    const detail = data.futureDetail
    if (!detail) return emptyContractDetails()

    const contract = new Map(detail.contractDetails.items.map((item) => [item.key, item.value]))
    const stats = new Map(detail.stats.items.map((item) => [item.key, item.value]))
    const sessionHigh = detail.stats.items.find((item) => item.text === "En yüksek")?.value
    const sessionLow = detail.stats.items.find((item) => item.text === "En düşük")?.value

    return {
      initialCollateral: parseTurkishNumber(contract.get("ic")),
      leverage: parseTurkishNumber(contract.get("lv")),
      contractSize: parseTurkishNumber(contract.get("un")),
      expiryDate: contract.get("rd") ?? null,
      sessionHigh: parseTurkishNumber(sessionHigh),
      sessionLow: parseTurkishNumber(sessionLow),
      settlementPrice: parseTurkishNumber(stats.get("sp")),
      previousSettlementPrice: parseTurkishNumber(stats.get("psp")),
      volume: parseTurkishNumber(stats.get("vo")),
      openInterest: parseTurkishNumber(stats.get("oi")),
    }
  }
}

function emptyContractDetails(): ViopContractDetails {
  return {
    initialCollateral: null,
    leverage: null,
    contractSize: null,
    expiryDate: null,
    sessionHigh: null,
    sessionLow: null,
    settlementPrice: null,
    previousSettlementPrice: null,
    volume: null,
    openInterest: null,
  }
}

function isExcludedContract(instrument: ScreenerInstrument): boolean {
  const type = instrument.values.find((value) => value.key === "underlyingInstrumentType")?.value
  return type !== null && type !== undefined && EXCLUDED_UNDERLYING_TYPES.has(type)
}

// VIOP lists several expiries per underlying; keep only the nearest-expiry
// (front-month) contract for each, preserving the volume-sorted order.
function frontMonthPerUnderlying(instruments: ScreenerInstrument[]): ScreenerInstrument[] {
  const best = new Map<string, { instrument: ScreenerInstrument; expiry: number }>()
  const order: string[] = []

  for (const instrument of instruments) {
    const values = new Map(instrument.values.map((value) => [value.key, value.value]))
    const groupKey = values.get("underlyingInstrumentSymbol") ?? instrument.uid
    const expiry = expirySortKey(values.get("redemptionDate"))
    const existing = best.get(groupKey)
    if (!existing) {
      best.set(groupKey, { instrument, expiry })
      order.push(groupKey)
    } else if (expiry < existing.expiry) {
      best.set(groupKey, { instrument, expiry })
    }
  }

  return order.map((key) => best.get(key)!.instrument)
}

function expirySortKey(text: string | null | undefined): number {
  const match = text?.match(/^(\d{2})\/(\d{2})\/(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const [, day, month, year] = match
  return (2000 + Number(year)) * 10000 + Number(month) * 100 + Number(day)
}

function toInstrument(instrument: ScreenerInstrument): ViopInstrument {
  const values = new Map(instrument.values.map((value) => [value.key, value.value]))
  const underlyingSymbol = values.get("underlyingInstrumentSymbol") ?? null
  return {
    uid: instrument.uid,
    symbol: instrument.symbol,
    displayName: underlyingSymbol ?? instrument.symbol,
    underlyingSymbol,
    lastPrice: parseTurkishNumber(values.get("price")),
    changePercent: parseTurkishNumber(values.get("percentageChangeDay")),
    volume: parseTurkishNumber(values.get("derivativeVolume")),
    currency: "TRY",
  }
}

function parseTurkishNumber(text: string | null | undefined): number | null {
  if (!text) return null
  const cleaned = text.replace(/[^\d,.-]/g, "")
  if (!cleaned) return null
  const normalized = cleaned.replace(/\./g, "").replace(",", ".")
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}
