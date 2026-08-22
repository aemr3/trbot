import type { ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"

/**
 * Translates brokerage instrument uids into the tickers the feed answers on.
 *
 * Every caller — charts, broker readings, stop rules, the agent — holds a
 * brokerage instrument uid, and persisted rules hold them too, so those
 * identifiers cannot be swapped for feed symbols. The feed, meanwhile, only
 * knows tickers.
 *
 * One of these is shared by every feed source addressed by uid, so the
 * brokerage's instrument list is read once for all of them rather than once per
 * source.
 */

/** How long a resolved instrument list is trusted before being re-read. */
const DEFAULT_TTL_MS = 5 * 60_000

export interface InstrumentSymbolsOptions {
  ttlMs?: number
  now?: () => number
}

export class InstrumentSymbols {
  private readonly byUid = new Map<string, ViopInstrument>()
  private readonly bySymbol = new Map<string, ViopInstrument>()
  private loadedAt = 0
  private loading: Promise<void> | null = null
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly instruments: ViopInstrumentSource,
    options: InstrumentSymbolsOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** The instrument behind a uid, or null when nothing is known by that name. */
  async find(instrumentUid: string, signal?: AbortSignal): Promise<ViopInstrument | null> {
    const known = this.byUid.get(instrumentUid)
    if (known) return known
    // A symbol that is already a symbol needs no list read at all.
    if (this.bySymbol.has(instrumentUid)) return null

    if (this.now() - this.loadedAt < this.ttlMs && this.loadedAt !== 0) return null
    await this.load(signal)
    return this.byUid.get(instrumentUid) ?? null
  }

  /** The instrument's own ticker. Anything unknown is passed through as given. */
  async symbolFor(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const instrument = await this.find(instrumentUid, signal)
    return instrument?.symbol ?? instrumentUid
  }

  /**
   * The cash instrument behind a contract.
   *
   * The broker feeds only report on cash equities, so a contract has to be
   * traded for its underlying before either can be read.
   */
  async underlyingFor(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const instrument = await this.find(instrumentUid, signal)
    if (!instrument) return instrumentUid
    return instrument.underlyingSymbol ?? instrument.symbol
  }

  private async load(signal?: AbortSignal): Promise<void> {
    // Concurrent reads are the norm; they share one list read.
    this.loading ??= this.instruments
      .listInstruments({ signal })
      .then((instruments) => {
        this.byUid.clear()
        this.bySymbol.clear()
        for (const instrument of instruments) {
          this.byUid.set(instrument.uid, instrument)
          this.bySymbol.set(instrument.symbol, instrument)
        }
        this.loadedAt = this.now()
      })
      .finally(() => {
        this.loading = null
      })
    await this.loading
  }
}
