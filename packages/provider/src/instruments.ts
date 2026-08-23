import { ApiHttpError, type ApiClient } from "@trbot/api"
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
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000

const COLUMNS: ScreenerColumnInput[] = [
  { id: "underlyingInstrumentSymbol", field: "underlying.symbol" },
  { id: "price", field: "derivativePrice.price" },
  { id: "percentageChangeDay", field: "percentageChange.percentageChangeDay" },
  { id: "derivativeVolume", field: "stats.volume" },
  { id: "redemptionDate", field: "redemptionDate" },
]

export interface ApiViopInstrumentSourceOptions {
  cacheTtlMs?: number
  now?: () => number
}

interface InstrumentRateLimit {
  until: number
  body: string
  operationName: string | undefined
}

/**
 * The tradable VIOP universe shared by every caller in one provider session.
 *
 * Contract identity changes slowly; live prices arrive on a separate stream. A
 * short cache therefore keeps charts, tools, and the watchlist from independently
 * paging the same screener. An expired snapshot also remains usable while the
 * brokerage is throttling reads.
 */
export class ApiViopInstrumentSource implements ViopInstrumentSource {
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private snapshot: ViopInstrument[] | null = null
  private expiresAt = 0
  private loading: Promise<ViopInstrument[]> | null = null
  private rateLimit: InstrumentRateLimit | null = null

  constructor(
    private readonly client: MarketApiClient,
    options: ApiViopInstrumentSourceOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  async listInstruments(options: { signal?: AbortSignal } = {}): Promise<ViopInstrument[]> {
    const now = this.now()
    if (this.snapshot && now < this.expiresAt) return this.snapshot
    if (this.rateLimit && now < this.rateLimit.until) {
      if (this.snapshot) return this.snapshot
      throw new ApiHttpError(
        429,
        this.rateLimit.body,
        this.rateLimit.until - now,
        this.rateLimit.operationName,
      )
    }

    this.loading ??= this.refreshInstruments(options.signal).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async refreshInstruments(signal?: AbortSignal): Promise<ViopInstrument[]> {
    try {
      const instruments = await this.loadInstruments(signal)
      this.snapshot = instruments
      this.expiresAt = this.now() + this.cacheTtlMs
      this.rateLimit = null
      return instruments
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 429) {
        const cooldown = Math.max(error.retryAfterMs ?? 0, DEFAULT_RATE_LIMIT_COOLDOWN_MS)
        this.rateLimit = {
          until: this.now() + cooldown,
          body: error.responseBody,
          operationName: error.operationName,
        }
        if (this.snapshot) return this.snapshot
      }
      throw error
    }
  }

  private async loadInstruments(signal?: AbortSignal): Promise<ViopInstrument[]> {
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

    return frontMonthPerUnderlying(instruments).map(toInstrument)
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

// VIOP lists several expiries per underlying; keep only the nearest-expiry
// (front-month) contract for each, preserving the volume-sorted order. Every
// underlying type remains available: equities, indices, currencies, and metals.
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
