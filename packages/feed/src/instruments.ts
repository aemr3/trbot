import { z } from "zod"
import type {
  CandleInstrumentResolver,
  CandleInstrumentTarget,
  ResolvedCandleInstrument,
} from "@trbot/market/candle.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

/** The kinds of instrument the universe endpoint reports. */
export const INSTRUMENT_KINDS = [
  "equity",
  "index",
  "fx",
  "currency",
  "crypto",
  "fund",
  "pfund",
  "efund",
  "gms",
  "ems",
] as const

export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number]

export interface FeedInstrument {
  symbol: string
  title: string
  kind: InstrumentKind
  decimals: number | null
  /** Trading hours as the feed states them, e.g. `0955-1810` or `0920-1810,1900-2300`. */
  session: string | null
}

/**
 * An active contract, as the collections endpoint lists it.
 *
 * Deliberately not a `FeedInstrument`: that endpoint carries codes and nothing
 * else, so decimals and trading hours are absent rather than null. Read them
 * from the market data feed's `/symbols` when they are needed.
 */
export interface FeedFutureInstrument {
  symbol: string
  title: string
  /** The cash instrument the contract settles against, parsed from the code. */
  underlying: string
  /** Contract month, as `YYYY-MM`. */
  contractMonth: string
}

const UniverseSchema = z.object({
  data: z.array(
    z.object({
      code: z.string().min(1),
      title: z.string().default(""),
      type: z.string(),
      session: z.string().nullish(),
      format: z.object({ decimals: z.number().nullish() }).nullish(),
    }),
  ),
})

const CollectionsSchema = z.array(
  z.object({
    title: z.string(),
    data: z.array(z.string()),
  }),
)

/** The collection holding the tradable futures contracts. */
// Fintables uses U+0130 in this exact collection title; application copy uses VIOP.
const ACTIVE_FUTURES_COLLECTION = "V\u0130OP Aktif Vade"

const FUTURE_CODE = /^F_([A-Z0-9]+?)(\d{2})(\d{2})$/

// Fintables names the gram-gold future XAUTRYM while the rest of the product
// calls its underlying XAUTRY. This is a display/input alias only: Fintables has
// no spot candle ticker for either spelling.
const FUTURE_UNDERLYING_BY_ALIAS = new Map([["XAUTRY", "XAUTRYM"]])
const FUTURE_ALIAS_BY_UNDERLYING = new Map(
  [...FUTURE_UNDERLYING_BY_ALIAS].map(([alias, underlying]) => [underlying, alias]),
)

/**
 * Splits a contract code into its underlying and contract month.
 *
 * Codes are `F_<UNDERLYING><MMYY>`, so `F_XU0300826` is the August 2026 BIST 30
 * contract. The underlying itself can contain digits (`XU030`), which is why the
 * month is taken from the end rather than by scanning for the first digit.
 */
export function parseFutureCode(code: string): { underlying: string; contractMonth: string } | null {
  const match = FUTURE_CODE.exec(code)
  if (!match) return null
  const [, underlying, month, year] = match
  if (!underlying || !month || !year) return null
  const monthNumber = Number(month)
  if (monthNumber < 1 || monthNumber > 12) return null
  return { underlying, contractMonth: `20${year}-${month}` }
}

function isInstrumentKind(value: string): value is InstrumentKind {
  return INSTRUMENT_KINDS.some((kind) => kind === value)
}

export interface FeedInstrumentSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
}

/**
 * The instrument universe.
 *
 * Two endpoints are needed rather than one, and not by choice: the universe
 * endpoint carries every cash instrument but **no futures at all**, while the
 * collections endpoint is the only JSON source of active contract codes. A
 * `type` filter on the universe endpoint is accepted and then ignored, so
 * filtering happens here.
 *
 * Contract size and collateral are deliberately absent from this identity
 * source. The cross-sectional margin source reads current feed values, while
 * brokerage contract details remain authoritative for sizing an actual order.
 */
export class FeedInstrumentSource implements CandleInstrumentResolver {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private universe: FeedInstrument[] | null = null
  private futures: FeedFutureInstrument[] | null = null

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    options: FeedInstrumentSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  /** Every cash instrument. Cached: it is a single large response that does not move intraday. */
  async listInstruments(options: { signal?: AbortSignal } = {}): Promise<FeedInstrument[]> {
    if (this.universe) return this.universe
    const parsed = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        { url: buildUrl(this.baseUrl, "/symbols/"), token, signal: options.signal },
        UniverseSchema,
      ))
    this.universe = parsed.data.flatMap((row) => {
      if (!isInstrumentKind(row.type)) return []
      return [{
        symbol: row.code,
        title: row.title,
        kind: row.type,
        decimals: row.format?.decimals ?? null,
        session: row.session ?? null,
      }]
    })
    return this.universe
  }

  async listByKind(kind: InstrumentKind, options: { signal?: AbortSignal } = {}): Promise<FeedInstrument[]> {
    return (await this.listInstruments(options)).filter((instrument) => instrument.kind === kind)
  }

  /** The active futures contracts, newest-dated last. */
  async listFutures(options: { signal?: AbortSignal } = {}): Promise<FeedFutureInstrument[]> {
    if (this.futures) return this.futures
    const collections = await this.loadCollections(options.signal)
    const active = collections.find((collection) => collection.title === ACTIVE_FUTURES_COLLECTION)
      ?? collections.find((collection) => collection.data.some((code) => code.startsWith("F_")))
    if (!active) {
      this.futures = []
      return this.futures
    }

    this.futures = active.data.flatMap((code) => {
      const parsed = parseFutureCode(code)
      if (!parsed) return []
      return [{
        symbol: code,
        title: `${parsed.underlying} ${parsed.contractMonth}`,
        underlying: parsed.underlying,
        contractMonth: parsed.contractMonth,
      }]
    }).sort((left, right) =>
      left.underlying === right.underlying
        ? left.contractMonth.localeCompare(right.contractMonth)
        : left.underlying.localeCompare(right.underlying)
    )
    return this.futures
  }

  /** Index constituents, keyed by index code — `XU100`, `XU030`, `XUTUM`. */
  async listIndexMembers(index: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const collections = await this.loadCollections(options.signal)
    return collections.find((collection) => collection.title === index)?.data ?? []
  }

  /** Every contract on one underlying, nearest month first. */
  async contractsFor(underlying: string, options: { signal?: AbortSignal } = {}): Promise<FeedFutureInstrument[]> {
    const wanted = underlying.trim().toUpperCase()
    return (await this.listFutures(options)).filter((contract) => contract.underlying === wanted)
  }

  /**
   * Resolves a candle request from the feed's own active-contract and cash/spot
   * universes, without consulting the brokerage or requiring its instrument uid.
   */
  async resolveCandleInstrument(
    symbol: string,
    target: CandleInstrumentTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResolvedCandleInstrument> {
    const wanted = symbol.trim().toUpperCase()
    const [futures, instruments] = await Promise.all([
      this.listFutures(options),
      this.listInstruments(options),
    ])
    const wantedUnderlying = FUTURE_UNDERLYING_BY_ALIAS.get(wanted) ?? wanted
    const contract = futures.find((future) => future.symbol === wanted)
      ?? futures.find((future) => future.underlying === wantedUnderlying)
    if (!contract) {
      throw new Error(
        `No active VIOP contract matches ${symbol}. Only nearest-expiry contracts are available; use an exact listed contract or its underlying symbol instead of constructing an expiry code.`,
      )
    }

    const displayName = FUTURE_ALIAS_BY_UNDERLYING.get(contract.underlying) ?? contract.underlying
    const underlying = instruments.find((instrument) =>
      instrument.symbol === contract.underlying || instrument.symbol === displayName
    ) ?? null

    if (target === "UNDERLYING" && !underlying) {
      throw new Error(`${displayName} has no underlying cash/spot candle instrument; use target INSTRUMENT`)
    }
    const candleSymbol = target === "INSTRUMENT" ? contract.symbol : underlying?.symbol
    if (!candleSymbol) throw new Error(`No candle symbol resolved for ${displayName}`)

    return {
      candleSymbol,
      contractSymbol: contract.symbol,
      underlyingSymbol: underlying?.symbol ?? null,
      displayName,
    }
  }

  private async loadCollections(signal?: AbortSignal): Promise<{ title: string; data: string[] }[]> {
    return withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        { url: buildUrl(this.baseUrl, "/mobile/symbols/collections/"), token, signal },
        CollectionsSchema,
      ))
  }
}
