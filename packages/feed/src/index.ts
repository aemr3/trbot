import type { DepthStreamOptions } from "@trbot/market/depth.ts"
import { FeedBrokerageDirectory } from "./brokerages.ts"
import { FeedBrokerVolumeSource } from "./broker-volume.ts"
import { FeedCandleSource } from "./candles.ts"
import { FeedDepthStream } from "./depth-stream.ts"
import { FeedEquityQuoteStream } from "./equity-quote-stream.ts"
import { FeedRecentFinancialSource } from "./financials.ts"
import { FeedInstrumentSource } from "./instruments.ts"
import { FeedIndexImpactSource } from "./index-impact.ts"
import { FeedQuoteStream } from "./quote-stream.ts"
import { FeedSession, type FeedCredentials, type FeedEntitlements } from "./session.ts"
import { FeedShortSaleSource } from "./short-sales.ts"
import { FeedTradeSource } from "./trades.ts"
import { FeedTradingDays } from "./trading-days.ts"
import { closeFeedHttpTransport } from "./transport.ts"
import { FeedViopMarginSource } from "./viop-margin.ts"
import { MarketSocket } from "./socket.ts"

export * from "./broker-headline.ts"
export * from "./brokerage.ts"
export * from "./brokerages.ts"
export * from "./broker-volume.ts"
export * from "./candles.ts"
export * from "./depth-stream.ts"
export * from "./equity-quote-stream.ts"
export * from "./features.ts"
export * from "./financials.ts"
export * from "./fields.ts"
export * from "./frames.ts"
export * from "./instrument-candles.ts"
export * from "./instrument-availability.ts"
export * from "./instrument-symbols.ts"
export * from "./instruments.ts"
export * from "./index-impact.ts"
export * from "./quote-stream.ts"
export * from "./session-hours.ts"
export * from "./session.ts"
export * from "./short-sales.ts"
export * from "./settlement.ts"
export * from "./socket.ts"
export * from "./trades.ts"
export * from "./trading-days.ts"
export * from "./transport.ts"
export * from "./value.ts"
export * from "./viop-margin.ts"

export interface MarketFeedOptions {
  credentials: FeedCredentials
  onError?: (label: string, cause: unknown) => void
  /**
   * Called when the realtime licence is claimed by another device. The feed does
   * not fight for it, so this is how the application learns that live prices have
   * stopped and only delayed reads remain.
   */
  onLicenseTaken?: () => void
}

/**
 * The market data feed: one login, one realtime connection, and the sources
 * built on them.
 *
 * The single socket is load bearing. The exchange licence is valid on one device
 * at a time, so every quote and depth consumer shares this connection; opening a
 * second would evict the first.
 *
 * The feed's lifetime is independent of the brokerage session — it is a separate
 * account — so one of these is created at startup and outlives any number of
 * brokerage sign-ins.
 */
export class MarketFeed {
  readonly session: FeedSession
  readonly socket: MarketSocket
  readonly candles: FeedCandleSource
  readonly financials: FeedRecentFinancialSource
  readonly instruments: FeedInstrumentSource
  readonly indexImpact: FeedIndexImpactSource
  readonly shortSales: FeedShortSaleSource
  readonly viopMargins: FeedViopMarginSource
  readonly brokerVolumes: FeedBrokerVolumeSource
  readonly trades: FeedTradeSource
  /** Shared by every broker feed, so the house names are read once per run. */
  readonly brokerages: FeedBrokerageDirectory
  /** The trading days the broker readings can be taken over. */
  readonly tradingDays: FeedTradingDays

  constructor(private readonly options: MarketFeedOptions) {
    this.session = new FeedSession({
      credentials: options.credentials,
      onStreamTokenRotated: () => {
        // The open socket is bound to the retired licence, so redial with the new
        // one. Subscriptions are kept: a rotation must not silently go quiet.
        this.socket.redial()
      },
    })
    this.socket = new MarketSocket(this.session, {
      onError: (cause) => options.onError?.("market-socket", cause),
    })
    this.indexImpact = new FeedIndexImpactSource(this.socket, {
      onLicenseTaken: options.onLicenseTaken,
    })
    this.candles = new FeedCandleSource(this.session)
    this.instruments = new FeedInstrumentSource(this.session)
    this.financials = new FeedRecentFinancialSource(this.session, this.instruments)
    this.shortSales = new FeedShortSaleSource(this.session)
    this.viopMargins = new FeedViopMarginSource(this.session, this.instruments)
    this.brokerVolumes = new FeedBrokerVolumeSource(this.session)
    this.brokerages = new FeedBrokerageDirectory(this.session)
    this.trades = new FeedTradeSource(this.session, { brokerages: this.brokerages })
    this.tradingDays = new FeedTradingDays(this.candles)
  }

  /** Whether this account may read live prices and depth, once the login has run. */
  get entitlements(): FeedEntitlements | null {
    return this.session.entitlements
  }

  /**
   * Streams share the socket but not their lifetime: each consumer gets its own
   * view so that stopping one does not blind the others.
   */
  openQuoteStream(): FeedQuoteStream {
    return new FeedQuoteStream(this.socket, {
      onLicenseTaken: this.options.onLicenseTaken,
      sessionFor: (symbol) => this.sessions.get(symbol) ?? null,
    })
  }

  openEquityQuoteStream(): FeedEquityQuoteStream {
    return new FeedEquityQuoteStream(this.socket, {
      onLicenseTaken: this.options.onLicenseTaken,
      sessionFor: (symbol) => this.sessions.get(symbol) ?? null,
    })
  }

  openDepthStream(options: DepthStreamOptions = {}): FeedDepthStream {
    return new FeedDepthStream(this.socket, {
      onLicenseTaken: this.options.onLicenseTaken,
      loadSession: (symbol) => this.loadSession(symbol),
      // The socket only carries new prints, so the tape is seeded over HTTP.
      loadTrades: (symbol) => this.trades.listTrades(symbol),
      brokerageNames: () => this.brokerages.names(),
      requestSnapshot: options.requestSnapshot,
    })
  }

  /**
   * Remembers each symbol's trading hours as they are read, so a depth book can
   * say whether an empty book means a closed market.
   */
  private readonly sessions = new Map<string, string>()

  /**
   * Reads a symbol's session hours into the cache the streams consult.
   *
   * Quotes arrive far too often to await a lookup per tick, so they read the
   * cache and report no status until it is warm. Depth awaits it, because a book
   * is published rarely enough to afford it.
   */
  async loadSession(symbol: string): Promise<string | null> {
    const known = this.sessions.get(symbol)
    if (known) return known
    const info = await this.candles.loadSymbolInfo(symbol)
    if (info?.session) this.sessions.set(symbol, info.session)
    return info?.session ?? null
  }

  close(): void {
    this.socket.stop()
    closeFeedHttpTransport()
  }
}
