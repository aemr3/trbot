import type {
  InstrumentMarketKind,
  ViopContractDetails,
  ViopInstrument,
  ViopInstrumentSource,
} from "@trbot/market/instrument.ts"
import type { FeedInstrument, FeedInstrumentSource, InstrumentKind } from "./instruments.ts"

/**
 * Adds the market-data capabilities the brokerage instrument list cannot know.
 *
 * The brokerage owns tradable contracts; the feed independently owns candles
 * and cash/spot instruments. Comparing their current universes keeps clients
 * from assuming that every futures underlying is a cash equity.
 */
export class FeedAwareInstrumentSource implements ViopInstrumentSource {
  constructor(
    private readonly instruments: ViopInstrumentSource,
    private readonly feedInstruments: Pick<FeedInstrumentSource, "listInstruments" | "listFutures">,
  ) {}

  async listInstruments(options: { signal?: AbortSignal } = {}): Promise<ViopInstrument[]> {
    const [instruments, feedInstruments, futures] = await Promise.all([
      this.instruments.listInstruments(options),
      this.feedInstruments.listInstruments(options),
      this.feedInstruments.listFutures(options),
    ])
    const feedBySymbol = new Map(feedInstruments.map((instrument) => [instrument.symbol.toUpperCase(), instrument]))
    const futureBySymbol = new Map(futures.map((future) => [future.symbol.toUpperCase(), future]))

    return instruments.map((instrument) => {
      const future = futureBySymbol.get(instrument.symbol.toUpperCase())
      const underlying = findUnderlying(feedBySymbol, instrument.underlyingSymbol, future?.underlying)
      return {
        ...instrument,
        marketData: {
          instrumentCandles: future !== undefined,
          underlyingSymbol: underlying?.symbol ?? null,
          underlyingKind: underlying ? marketKind(underlying.kind) : null,
          brokerAnalytics: underlying?.kind === "equity",
        },
      }
    })
  }

  async loadContractDetails(
    instrumentUid: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ViopContractDetails> {
    if (!this.instruments.loadContractDetails) {
      throw new Error("Contract details are not available from this instrument source")
    }
    return this.instruments.loadContractDetails(instrumentUid, options)
  }
}

function findUnderlying(
  feedBySymbol: Map<string, FeedInstrument>,
  brokerageSymbol: string | null,
  contractUnderlying?: string,
): FeedInstrument | null {
  for (const symbol of [brokerageSymbol, contractUnderlying]) {
    if (!symbol) continue
    const found = feedBySymbol.get(symbol.toUpperCase())
    if (found) return found
  }
  return null
}

function marketKind(kind: InstrumentKind): InstrumentMarketKind {
  if (kind === "equity") return "equity"
  if (kind === "index") return "index"
  if (kind === "fx" || kind === "currency" || kind === "crypto") return "currency"
  if (kind === "gms" || kind === "ems") return "commodity"
  return "other"
}
