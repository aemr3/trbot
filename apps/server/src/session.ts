import {
  createApiClient,
  OtpRequiredError,
  resumeApiClient,
  type ApiClient,
  type ApiClientHandle,
} from "@trbot/api"
import type { OpenAuthSession } from "@trbot/auth/session.ts"
import type { AppCredentials } from "@trbot/config"
import {
  FeedBrokerageDistributionSource,
  FeedAwareInstrumentSource,
  FeedMemberFeatureSource,
  FeedSettlementSource,
  InstrumentCandleSource,
  InstrumentSymbols,
  type MarketFeed,
} from "@trbot/feed"
import type { BrokerageDistributionSource } from "@trbot/market/brokerage.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { DepthStream, DepthStreamOptions } from "@trbot/market/depth.ts"
import type { EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import type { RecentFinancialSource } from "@trbot/market/financials.ts"
import type { ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { NewsSource } from "@trbot/market/news.ts"
import type { QuoteStream } from "@trbot/market/quote-stream.ts"
import type { SettlementSource } from "@trbot/market/settlement.ts"
import type { MemberFeatureSource } from "@trbot/member/features.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ApiAccountResolver } from "@trbot/provider/account-resolver.ts"
import { ApiAccountSource } from "@trbot/provider/account.ts"
import { ApiAccountStream } from "@trbot/provider/account-stream.ts"
import { ApiMemberFeatureSource } from "@trbot/provider/features.ts"
import { ApiViopInstrumentSource } from "@trbot/provider/instruments.ts"
import { ApiNewsSource } from "@trbot/provider/news.ts"
import { ApiViopOrderSource } from "@trbot/provider/order.ts"
import type { AccountSource, AccountStream } from "@trbot/trading/account.ts"
import type {
  ViopOrderCancellationSource,
  ViopOrderSource,
  ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { toProtocolError } from "./errors.ts"

/** Everything the routes and the stream hub read from the provider. */
export interface ProviderSources {
  instruments: ViopInstrumentSource
  financials: RecentFinancialSource
  candles: CandleSource
  news: NewsSource
  account: AccountSource
  orders: ViopOrderSource & ViopOrderCancellationSource & ViopPositionExitSource
  brokerage: BrokerageDistributionSource
  settlement: SettlementSource
  memberFeatures: MemberFeatureSource
  quotes: QuoteStream
  accountStream: AccountStream
  /**
   * Depth and equity quotes carry one symbol per upstream connection, so these
   * open a stream per symbol rather than sharing one. The session tracks what it
   * hands out and stops it all when the session ends.
   */
  openDepthStream(options?: DepthStreamOptions): DepthStream
  openEquityQuoteStream(): EquityQuoteStream
}

export interface ProviderSessionOptions {
  openAuthSession: OpenAuthSession
  credentials: AppCredentials | null
  onError?: (label: string, cause: unknown) => void
  onInfo?: (label: string, message: string) => void
  /**
   * Opens provider handles. `providerConnector(feed)` is the real one; it carries
   * the market data feed because it is what builds sources from it.
   */
  connector: ProviderSessionConnector
}

interface StoppableProviderStream {
  stop(): void
}

export interface ProviderSourceOptions {
  track(stream: StoppableProviderStream): void
  report(label: string, cause: unknown): void
  info(label: string, message: string): void
}

/** A provider login plus the source objects that login owns. */
export interface ProviderSessionHandle {
  authenticate(): Promise<void>
  reauthenticate(): Promise<void>
  requestNewOtp(): Promise<void>
  completeLogin(code: string): Promise<void>
  sources(options: ProviderSourceOptions): ProviderSources
  close(): void
}

export interface ProviderOtpChallenge {
  /** Provider challenge expiry as Unix epoch milliseconds. */
  expiresAt: number | null
}

/** Opens provider handles; tests replace this boundary without imitating ApiClient internals. */
export interface ProviderSessionConnector {
  open(openAuthSession: OpenAuthSession, credentials: AppCredentials): Promise<ProviderSessionHandle>
  resume(openAuthSession: OpenAuthSession, credentials: AppCredentials | null): Promise<ProviderSessionHandle | null>
}

/** Provider-session surface consumed by HTTP routing and stream fan-out. */
export interface ProviderSessionAccess {
  readonly authenticated: boolean
  readonly otpChallenge: ProviderOtpChallenge | null
  onExpired(listener: () => void): void
  onSession(listener: () => void): void
  login(username: string, password: string): Promise<void>
  requestNewOtp(): Promise<void>
  completeOtp(code: string): Promise<void>
  require(): ProviderSources
  recover(): Promise<boolean>
}

/**
 * Owns the single provider connection. Exactly one of these exists per process,
 * which is what keeps refresh-token rotation from racing: no other component
 * holds an API client.
 */
export class ProviderSession implements ProviderSessionAccess {
  private handle: ProviderSessionHandle | null = null
  private current: ProviderSources | null = null
  private pendingOtp: { handle: ProviderSessionHandle; expiresAt: number | null } | null = null
  private recovering: Promise<boolean> | null = null
  private opened: { stop(): void }[] = []
  private readonly expiryListeners: (() => void)[] = []
  private readonly sessionListeners: (() => void)[] = []

  private readonly connector: ProviderSessionConnector

  constructor(private readonly options: ProviderSessionOptions) {
    this.connector = options.connector
  }

  get authenticated(): boolean {
    return this.current !== null
  }

  get otpChallenge(): ProviderOtpChallenge | null {
    return this.pendingOtp ? { expiresAt: this.pendingOtp.expiresAt } : null
  }

  onExpired(listener: () => void): void {
    this.expiryListeners.push(listener)
  }

  /**
   * Called whenever a session is adopted — a sign-in, or a recovery that
   * succeeded with nobody attached.
   *
   * Every source object is replaced, so anything holding a subscription is now
   * listening to a stream that has been stopped. Recovery is the case that
   * matters: it happens on its own, with no client action afterwards to
   * resubscribe, so without this the server goes quiet while looking healthy.
   */
  onSession(listener: () => void): void {
    this.sessionListeners.push(listener)
  }

  /** Rebuilds a session from stored credentials. Returns false when none works. */
  async resume(): Promise<boolean> {
    const handle = await this.connector.resume(this.options.openAuthSession, this.options.credentials)
    if (!handle) return false

    try {
      await handle.authenticate()
      this.adopt(handle)
      return true
    } catch (error) {
      const protocolError = toProtocolError(error)
      if (protocolError.code === "otp_required") {
        this.rememberOtp(handle, error instanceof OtpRequiredError ? error.expiresAt : null)
        const reason = error instanceof OtpRequiredError ? error.reason : "the provider requires SMS verification"
        this.options.onInfo?.("Session recovery", `SMS verification required: ${reason}`)
        return false
      }
      handle.close()
      this.options.onError?.("Session recovery", error)
      return false
    }
  }

  /**
   * Signs in with a username and password. Throws a protocol error carrying
   * `otp_required` when the provider asks for the SMS code, in which case the
   * half-built session is held for `completeOtp`.
   */
  async login(username: string, password: string): Promise<void> {
    const handle = await this.connector.open(this.options.openAuthSession, { username, password })
    try {
      await handle.reauthenticate()
      this.adopt(handle)
    } catch (error) {
      const protocolError = toProtocolError(error)
      if (protocolError.code === "otp_required") {
        this.rememberOtp(handle, error instanceof OtpRequiredError ? error.expiresAt : null)
      } else {
        handle.close()
      }
      throw protocolError
    }
  }

  /** Replaces an expired challenge using the credentials already held by its handle. */
  async requestNewOtp(): Promise<void> {
    const pending = this.pendingOtp
    if (!pending) throw new ProtocolError("invalid_request", "No sign-in is waiting for a verification code")
    if (pending.expiresAt === null) {
      throw new ProtocolError("invalid_request", "The verification-code expiry is unavailable; sign in again")
    }
    if (pending.expiresAt > Date.now()) {
      throw new ProtocolError("invalid_request", "The current verification code has not expired")
    }

    try {
      await pending.handle.requestNewOtp()
      throw new ProtocolError("internal", "The provider did not start a new SMS challenge")
    } catch (error) {
      const protocolError = toProtocolError(error)
      if (protocolError.code !== "otp_required") throw protocolError
      this.rememberOtp(pending.handle, error instanceof OtpRequiredError ? error.expiresAt : null)
    }
  }

  async completeOtp(code: string): Promise<void> {
    const pending = this.pendingOtp
    if (!pending) throw new ProtocolError("invalid_request", "No sign-in is waiting for a verification code")
    if (pending.expiresAt !== null && pending.expiresAt <= Date.now()) {
      throw new ProtocolError("invalid_request", "The verification code expired; request a new SMS")
    }

    try {
      await pending.handle.completeLogin(code)
      this.pendingOtp = null
      this.adopt(pending.handle)
    } catch (error) {
      throw toProtocolError(error)
    }
  }

  /** The live sources, or a protocol error telling the client to sign in. */
  require(): ProviderSources {
    if (!this.current) throw new ProtocolError("unauthenticated", "The server has no provider session")
    return this.current
  }

  /**
   * Rebuilds the session after the provider stopped accepting it.
   *
   * Stored credentials let the server sign itself back in with nobody attached,
   * which is what keeps stop rules alive across a token expiry overnight. When
   * there are none, or the retry fails, the session expires and clients are told
   * to sign in. Concurrent callers share one attempt.
   */
  async recover(): Promise<boolean> {
    this.recovering ??= this.attemptRecovery().finally(() => {
      this.recovering = null
    })
    return this.recovering
  }

  private async attemptRecovery(): Promise<boolean> {
    this.dropSession()
    // Attempted whether or not there are credentials to fall back on: resuming
    // reads the stored session, and a refresh token that is still good needs
    // nothing else. Credentials only matter when that has run out too.
    try {
      if (await this.resume()) return true
    } catch (error) {
      this.options.onError?.("Session recovery", error)
    }
    this.expire()
    return false
  }

  /** Drops the session and tells listeners, so clients are asked to sign in. */
  expire(): void {
    this.dropSession()
    for (const listener of this.expiryListeners) listener()
  }

  close(): void {
    this.dropSession()
    this.pendingOtp?.handle.close()
    this.pendingOtp = null
  }

  private dropSession(): void {
    this.current?.quotes.stop()
    this.current?.accountStream.stop()
    for (const stream of this.opened) stream.stop()
    this.opened = []
    this.current = null
    this.handle?.close()
    this.handle = null
  }

  private track(stream: StoppableProviderStream): void {
    this.opened.push(stream)
  }

  private adopt(handle: ProviderSessionHandle): void {
    // Every stream the last session handed out is still connected and still
    // tracked. Replacing `current` alone would leave them running against the
    // provider — a second set of quote and account subscriptions, and per-symbol
    // depth streams nothing would ever stop. Recovery already drops the session
    // first; a sign-in over a live one does not.
    this.dropSession()
    // A half-finished sign-in is stale the moment any session replaces it.
    // Left alone, its verification code stays redeemable: a second terminal
    // could complete a challenge from before this session and take its place.
    if (this.pendingOtp?.handle !== handle) {
      this.pendingOtp?.handle.close()
      this.pendingOtp = null
    }
    this.handle = handle
    this.current = handle.sources({
      track: (stream) => this.track(stream),
      report: (label, cause) => this.options.onError?.(label, cause),
      info: (label, message) => this.options.onInfo?.(label, message),
    })

    for (const listener of this.sessionListeners) listener()
  }

  private rememberOtp(handle: ProviderSessionHandle, expiresAt: number | null): void {
    if (this.pendingOtp?.handle !== handle) this.pendingOtp?.handle.close()
    this.pendingOtp = { handle, expiresAt }
  }
}

/**
 * The real connector, bound to the feed its sources read market data from.
 *
 * The feed arrives here rather than on the session because this is the only
 * place that builds sources with it: a session given a test connector never
 * touches market data at all, and should not have to hold a feed to prove it.
 */
export function providerConnector(feed: MarketFeed): ProviderSessionConnector {
  return {
    async open(openAuthSession, credentials) {
      return providerHandle(await createApiClient(openAuthSession, credentials), feed)
    },
    async resume(openAuthSession, credentials) {
      const handle = await resumeApiClient(openAuthSession, credentials)
      return handle ? providerHandle(handle, feed) : null
    },
  }
}

function providerHandle(handle: ApiClientHandle, feed: MarketFeed): ProviderSessionHandle {
  return {
    async authenticate(): Promise<void> {
      await handle.client.authenticate()
    },
    async reauthenticate(): Promise<void> {
      await handle.client.reauthenticate()
    },
    async requestNewOtp(): Promise<void> {
      await handle.client.requestNewLoginCode()
    },
    async completeLogin(code: string): Promise<void> {
      await handle.client.completeLogin(code)
    },
    sources: (options) => providerSources(handle.client, feed, options),
    close: () => handle.close(),
  }
}

/**
 * Builds the sources a session hands out.
 *
 * The split is by ownership, not by preference: every price, candle, book and
 * broker reading comes from the market data feed, while orders, positions,
 * contract terms and news stay with the brokerage that executes them. There is
 * no brokerage market-data path to fall back to — it was removed once the feed
 * replaced it, because a second, delayed, differently-shaped source of the same
 * numbers is worse than none.
 */
function providerSources(client: ApiClient, feed: MarketFeed, options: ProviderSourceOptions): ProviderSources {
  const accountResolver = new ApiAccountResolver(client)
  const orders = new ApiViopOrderSource(client, accountResolver)
  const report = (label: string) => (cause: unknown) => options.report(label, cause)
  const brokerageInstruments = new ApiViopInstrumentSource(client)
  const instruments = new FeedAwareInstrumentSource(brokerageInstruments, feed.instruments)
  // Callers address market data by brokerage instrument uid, including persisted
  // rules, while the feed knows only tickers. The translation needs the
  // brokerage's instrument list, so it is composed here rather than inside the
  // feed, which has no business knowing about the brokerage. One resolver serves
  // every feed source, so the list is read once for all of them.
  const symbols = new InstrumentSymbols(instruments)
  const brokerFeeds = {
    session: feed.session,
    symbols,
    tradingDays: feed.tradingDays,
    brokerages: feed.brokerages,
  }
  return {
    instruments,
    financials: feed.financials,
    candles: new InstrumentCandleSource(feed.candles, symbols),
    news: new ApiNewsSource(client),
    account: new ApiAccountSource(client, Date.now, accountResolver),
    orders,
    brokerage: new FeedBrokerageDistributionSource(brokerFeeds),
    settlement: new FeedSettlementSource(brokerFeeds),
    // Whoever serves the data answers for what may be read from it.
    memberFeatures: new FeedMemberFeatureSource(feed.session, {
      brokerage: new ApiMemberFeatureSource(client),
      onError: report("Member features"),
    }),
    quotes: feed.openQuoteStream(),
    accountStream: new ApiAccountStream(client, {
      onError: report("Account stream"),
      onRecovery: (channel, failures) => options.info(
        "Account stream",
        `${channel} stream recovered after ${failures} consecutive disconnects`,
      ),
    }),
    openDepthStream: (streamOptions) => {
      const stream = feed.openDepthStream(streamOptions)
      options.track(stream)
      return stream
    },
    openEquityQuoteStream: () => {
      const stream = feed.openEquityQuoteStream()
      options.track(stream)
      return stream
    },
  }
}
