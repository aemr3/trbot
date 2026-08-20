import { memberFeatureSet } from "@trbot/member/features.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ProviderSessionAccess, ProviderSources } from "./session.ts"

const unavailable = async (): Promise<never> => {
  throw new Error("Provider source is not configured for this test")
}

const noOp = (): void => {}

/** Complete provider sources with explicit no-op streams and failing request sources. */
export function providerSources(overrides: Partial<ProviderSources> = {}): ProviderSources {
  return {
    instruments: { listInstruments: unavailable, loadContractDetails: unavailable },
    candles: { loadCandles: unavailable },
    news: { listNews: unavailable, getArticle: unavailable },
    account: { loadAccount: unavailable },
    orders: {
      prepareOrder: unavailable,
      placeOrder: unavailable,
      listPendingOrders: unavailable,
      cancelPendingOrders: unavailable,
      exitAllPositions: unavailable,
      exitPosition: unavailable,
    },
    brokerage: { loadDistribution: unavailable },
    settlement: { loadSettlement: unavailable },
    memberFeatures: { loadFeatures: async () => memberFeatureSet([]) },
    quotes: { subscribe: noOp, onConnectionChange: noOp, start: noOp, stop: noOp },
    accountStream: {
      subscribe: noOp,
      onConnectionChange: noOp,
      setPendingOrders: noOp,
      start: noOp,
      stop: noOp,
    },
    openDepthStream: () => ({ subscribe: noOp, onStatusChange: noOp, start: noOp, stop: noOp }),
    openEquityQuoteStream: () => ({ subscribe: noOp, onConnectionChange: noOp, start: noOp, stop: noOp }),
    ...overrides,
  }
}

/** Mutable provider session used by route and stream-hub tests. */
export class TestProviderSession implements ProviderSessionAccess {
  private sources: ProviderSources | null
  private readonly expiredListeners: (() => void)[] = []
  private readonly sessionListeners: (() => void)[] = []

  constructor(
    sources: ProviderSources | null = null,
    private readonly recoverSession: () => Promise<ProviderSources | null> = async () => null,
  ) {
    this.sources = sources
  }

  get authenticated(): boolean {
    return this.sources !== null
  }

  onExpired(listener: () => void): void {
    this.expiredListeners.push(listener)
  }

  onSession(listener: () => void): void {
    this.sessionListeners.push(listener)
  }

  async login(): Promise<void> {
    throw new ProtocolError("unauthenticated", "Provider login is not configured for this test")
  }

  async completeOtp(): Promise<void> {
    throw new ProtocolError("invalid_request", "No sign-in is waiting for a verification code")
  }

  require(): ProviderSources {
    if (!this.sources) throw new ProtocolError("unauthenticated", "The server has no provider session")
    return this.sources
  }

  async recover(): Promise<boolean> {
    const sources = await this.recoverSession()
    if (!sources) {
      for (const listener of this.expiredListeners) listener()
      return false
    }
    this.setSources(sources)
    return true
  }

  setSources(sources: ProviderSources | null): void {
    this.sources = sources
    if (sources) {
      for (const listener of this.sessionListeners) listener()
    }
  }
}
