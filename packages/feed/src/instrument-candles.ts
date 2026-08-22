import type {
  CandleChartTarget,
  CandleInterval,
  CandleRange,
  CandleSeries,
  CandleSource,
} from "@trbot/market/candle.ts"
import type { InstrumentSymbols } from "./instrument-symbols.ts"

/**
 * Candles addressed the way the rest of the application addresses instruments.
 *
 * Callers hold brokerage instrument uids and the feed knows tickers, so this
 * translates between the two and hands back the uid the caller asked with, so a
 * response still matches the request that produced it.
 *
 * Contract symbols happen to share the exchange's own convention on both sides
 * (`F_THYAO0826`), so the translation is a lookup rather than a reformat.
 */

const INDEX_SYMBOL_BY_TARGET = new Map<CandleChartTarget, string>([
  ["BIST_100", "XU100"],
  ["BIST_30", "XU030"],
])

export class InstrumentCandleSource implements CandleSource {
  constructor(
    private readonly candles: CandleSource,
    private readonly symbols: InstrumentSymbols,
  ) {}

  async loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
    options: { signal?: AbortSignal; target?: CandleChartTarget } = {},
  ): Promise<CandleSeries> {
    const symbol = await this.resolve(instrumentUid, options.target, options.signal)
    const series = await this.candles.loadCandles(symbol, range, interval, options)
    // The caller matches the response against what it asked for, so the uid it
    // used has to come back rather than the ticker the feed answered on.
    return { ...series, instrumentUid }
  }

  /**
   * The feed symbol for an instrument and chart target.
   *
   * The default target is the underlying, matching what the charts have always
   * shown: a contract's price history is read from the stock or index it settles
   * against unless the contract itself was asked for.
   */
  private async resolve(
    instrumentUid: string,
    target: CandleChartTarget | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const index = target ? INDEX_SYMBOL_BY_TARGET.get(target) : undefined
    if (index) return index
    if (target === "INSTRUMENT") return this.symbols.symbolFor(instrumentUid, signal)
    return this.symbols.underlyingFor(instrumentUid, signal)
  }
}
