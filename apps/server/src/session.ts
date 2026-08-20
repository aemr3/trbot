import { createApiClient, resumeApiClient, type ApiClient, type ApiClientHandle } from "@trbot/api"
import type { OpenAuthSession } from "@trbot/auth/session.ts"
import type { AppCredentials } from "@trbot/config"
import type { BrokerageDistributionSource } from "@trbot/market/brokerage.ts"
import type { CandleSource } from "@trbot/market/candle.ts"
import type { DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import type { ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { NewsSource } from "@trbot/market/news.ts"
import type { QuoteStream } from "@trbot/market/quote-stream.ts"
import type { SettlementSource } from "@trbot/market/settlement.ts"
import type { MemberFeatureSource } from "@trbot/member/features.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ApiAccountSource } from "@trbot/provider/account.ts"
import { ApiAccountStream } from "@trbot/provider/account-stream.ts"
import { ApiBrokerageDistributionSource } from "@trbot/provider/brokerage.ts"
import { ApiCandleSource } from "@trbot/provider/candles.ts"
import { ApiDepthStream } from "@trbot/provider/depth-stream.ts"
import { ApiEquityQuoteStream } from "@trbot/provider/equity-quote-stream.ts"
import { ApiMemberFeatureSource } from "@trbot/provider/features.ts"
import { ApiViopInstrumentSource } from "@trbot/provider/instruments.ts"
import { ApiNewsSource } from "@trbot/provider/news.ts"
import { ApiViopOrderSource } from "@trbot/provider/order.ts"
import { ApiQuoteStream } from "@trbot/provider/quote-stream.ts"
import { ApiSettlementSource } from "@trbot/provider/settlement.ts"
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
  openDepthStream(): DepthStream
  openEquityQuoteStream(): EquityQuoteStream
}

export interface ProviderSessionOptions {
  openAuthSession: OpenAuthSession
  credentials: AppCredentials | null
  onError?: (label: string, cause: unknown) => void
  connector?: ProviderSessionConnector
}

interface StoppableProviderStream {
  stop(): void
}

export interface ProviderSourceOptions {
  track(stream: StoppableProviderStream): void
  report(label: string, cause: unknown): void
}

/** A provider login plus the source objects that login owns. */
export interface ProviderSessionHandle {
  authenticate(): Promise<void>
  reauthenticate(): Promise<void>
  completeLogin(code: string): Promise<void>
  sources(options: ProviderSourceOptions): ProviderSources
  close(): void
}

/** Opens provider handles; tests replace this boundary without imitating ApiClient internals. */
export interface ProviderSessionConnector {
  open(openAuthSession: OpenAuthSession, credentials: AppCredentials): Promise<ProviderSessionHandle>
  resume(openAuthSession: OpenAuthSession, credentials: AppCredentials | null): Promise<ProviderSessionHandle | null>
}

/** Provider-session surface consumed by HTTP routing and stream fan-out. */
export interface ProviderSessionAccess {
  readonly authenticated: boolean
  onExpired(listener: () => void): void
  onSession(listener: () => void): void
  login(username: string, password: string): Promise<void>
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
  private pendingOtp: ProviderSessionHandle | null = null
  private recovering: Promise<boolean> | null = null
  private opened: { stop(): void }[] = []
  private readonly expiryListeners: (() => void)[] = []
  private readonly sessionListeners: (() => void)[] = []

  private readonly connector: ProviderSessionConnector

  constructor(private readonly options: ProviderSessionOptions) {
    this.connector = options.connector ?? defaultProviderSessionConnector
  }

  get authenticated(): boolean {
    return this.current !== null
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
    } catch {
      handle.close()
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
        this.pendingOtp?.close()
        this.pendingOtp = handle
      } else {
        handle.close()
      }
      throw protocolError
    }
  }

  async completeOtp(code: string): Promise<void> {
    const handle = this.pendingOtp
    if (!handle) throw new ProtocolError("invalid_request", "No sign-in is waiting for a verification code")

    try {
      await handle.completeLogin(code)
      this.pendingOtp = null
      this.adopt(handle)
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
    this.pendingOtp?.close()
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
    if (this.pendingOtp !== handle) {
      this.pendingOtp?.close()
      this.pendingOtp = null
    }
    this.handle = handle
    this.current = handle.sources({
      track: (stream) => this.track(stream),
      report: (label, cause) => this.options.onError?.(label, cause),
    })

    for (const listener of this.sessionListeners) listener()
  }
}

const defaultProviderSessionConnector: ProviderSessionConnector = {
  async open(openAuthSession, credentials) {
    return providerHandle(await createApiClient(openAuthSession, credentials))
  },
  async resume(openAuthSession, credentials) {
    const handle = await resumeApiClient(openAuthSession, credentials)
    return handle ? providerHandle(handle) : null
  },
}

function providerHandle(handle: ApiClientHandle): ProviderSessionHandle {
  return {
    async authenticate(): Promise<void> {
      await handle.client.authenticate()
    },
    async reauthenticate(): Promise<void> {
      await handle.client.reauthenticate()
    },
    async completeLogin(code: string): Promise<void> {
      await handle.client.completeLogin(code)
    },
    sources: (options) => providerSources(handle.client, options),
    close: () => handle.close(),
  }
}

function providerSources(client: ApiClient, options: ProviderSourceOptions): ProviderSources {
  const orders = new ApiViopOrderSource(client)
  const report = (label: string) => (cause: unknown) => options.report(label, cause)
  return {
    instruments: new ApiViopInstrumentSource(client),
    candles: new ApiCandleSource(client),
    news: new ApiNewsSource(client),
    account: new ApiAccountSource(client),
    orders,
    brokerage: new ApiBrokerageDistributionSource(client),
    settlement: new ApiSettlementSource(client),
    memberFeatures: new ApiMemberFeatureSource(client),
    quotes: new ApiQuoteStream(client, { onError: report("Quote stream") }),
    accountStream: new ApiAccountStream(client, { onError: report("Account stream") }),
    openDepthStream: () => {
      const stream = new ApiDepthStream(client, { onError: report("Depth stream") })
      options.track(stream)
      return stream
    },
    openEquityQuoteStream: () => {
      const stream = new ApiEquityQuoteStream(client, { onError: report("Equity quote stream") })
      options.track(stream)
      return stream
    },
  }
}
