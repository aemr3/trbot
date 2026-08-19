import type { BrokerageDistribution, BrokerageDistributionRequest, BrokerageDistributionSource } from "@trbot/market/brokerage.ts"
import type {
  CandleChartTarget,
  CandleInterval,
  CandleRange,
  CandleSeries,
  CandleSource,
} from "@trbot/market/candle.ts"
import type { ViopContractDetails, ViopInstrument, ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { NewsArticle, NewsSource } from "@trbot/market/news.ts"
import type { OverviewSnapshotStore, StoredOverviewSnapshot } from "@trbot/market/overview.ts"
import type { SettlementAnalysis, SettlementRequest, SettlementSource } from "@trbot/market/settlement.ts"
import { isMemberFeature, memberFeatureSet, type MemberFeatureSet, type MemberFeatureSource } from "@trbot/member/features.ts"
import type { AppPreferences } from "@trbot/preferences/app.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { AccountSnapshot, AccountSource, PortfolioRange } from "@trbot/trading/account.ts"
import type {
  CancelPendingViopOrdersRequest,
  ExitViopPositionRequest,
  PendingViopOrder,
  PlaceViopOrderRequest,
  PlacedViopOrder,
  PrepareViopOrderRequest,
  SubmittedViopPositionExit,
  ViopOrderCancellationResult,
  ViopOrderCancellationSource,
  ViopOrderPreparation,
  ViopOrderSource,
  ViopPositionExitResult,
  ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { idempotencyKey, type HttpClient } from "./http.ts"

export class HttpInstrumentSource implements ViopInstrumentSource {
  constructor(private readonly http: HttpClient) {}

  listInstruments(options: { signal?: AbortSignal } = {}): Promise<ViopInstrument[]> {
    return this.http.get<ViopInstrument[]>(ROUTES.instruments, { signal: options.signal })
  }

  loadContractDetails(instrumentUid: string, options: { signal?: AbortSignal } = {}): Promise<ViopContractDetails> {
    return this.http.get<ViopContractDetails>(ROUTES.contractDetails(instrumentUid), { signal: options.signal })
  }
}

export class HttpCandleSource implements CandleSource {
  constructor(private readonly http: HttpClient) {}

  loadCandles(
    instrumentUid: string,
    range: CandleRange,
    interval: CandleInterval,
    options: { signal?: AbortSignal; target?: CandleChartTarget } = {},
  ): Promise<CandleSeries> {
    return this.http.get<CandleSeries>(ROUTES.candles(instrumentUid), {
      query: { range, interval, target: options.target },
      signal: options.signal,
    })
  }
}

export class HttpNewsSource implements NewsSource {
  constructor(private readonly http: HttpClient) {}

  listNews(options: { instrumentUid?: string; signal?: AbortSignal } = {}): Promise<NewsArticle[]> {
    return this.http.get<NewsArticle[]>(ROUTES.news, {
      query: { instrumentUid: options.instrumentUid },
      signal: options.signal,
    })
  }

  async getArticle(uid: string, options: { signal?: AbortSignal } = {}): Promise<NewsArticle | null> {
    try {
      return await this.http.get<NewsArticle>(ROUTES.article(uid), { signal: options.signal })
    } catch (error) {
      // A missing article is an absence, not a failure the screen should report.
      if (error instanceof ProtocolError && error.code === "not_found") return null
      throw error
    }
  }
}

export class HttpAccountSource implements AccountSource {
  constructor(private readonly http: HttpClient) {}

  loadAccount(options: { signal?: AbortSignal; portfolioRange?: PortfolioRange } = {}): Promise<AccountSnapshot> {
    return this.http.get<AccountSnapshot>(ROUTES.account, {
      query: { portfolioRange: options.portfolioRange },
      signal: options.signal,
    })
  }
}

export class HttpMemberFeatureSource implements MemberFeatureSource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Rebuilds the set from the enabled list. The set answers through a closure,
   * so it cannot be sent whole — receiving it as an object would give a value
   * with no `has` on it.
   */
  async loadFeatures(options: { signal?: AbortSignal } = {}): Promise<MemberFeatureSet> {
    const enabled = await this.http.get<unknown[]>(ROUTES.memberFeatures, { signal: options.signal })
    return memberFeatureSet(enabled.filter(isMemberFeature))
  }
}

export class HttpBrokerageDistributionSource implements BrokerageDistributionSource {
  constructor(private readonly http: HttpClient) {}

  loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    const { signal, ...body } = request
    return this.http.post<BrokerageDistribution>(ROUTES.brokerageDistribution, { body, signal })
  }
}

export class HttpSettlementSource implements SettlementSource {
  constructor(private readonly http: HttpClient) {}

  loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis> {
    const { signal, ...body } = request
    return this.http.post<SettlementAnalysis>(ROUTES.settlement, { body, signal })
  }
}

/**
 * Order routes carry an idempotency key, so a retry after a dropped connection
 * cannot place a second live order.
 *
 * The key comes from the caller, because only the caller knows whether a second
 * press means "the first one may not have landed" or "place another". A caller
 * that supplies none still gets a key, but a fresh one each time, which
 * deduplicates nothing.
 */
export class HttpOrderSource implements ViopOrderSource, ViopOrderCancellationSource, ViopPositionExitSource {
  constructor(private readonly http: HttpClient) {}

  prepareOrder(request: PrepareViopOrderRequest): Promise<ViopOrderPreparation> {
    const { signal, ...body } = request
    return this.http.post<ViopOrderPreparation>(ROUTES.prepareOrder, { body, signal })
  }

  placeOrder(request: PlaceViopOrderRequest): Promise<PlacedViopOrder> {
    const { signal, idempotencyKey: key, ...body } = request
    return this.http.post<PlacedViopOrder>(ROUTES.placeOrder, {
      body,
      signal,
      idempotencyKey: key ?? idempotencyKey(),
    })
  }

  listPendingOrders(options: { signal?: AbortSignal } = {}): Promise<PendingViopOrder[]> {
    return this.http.get<PendingViopOrder[]>(ROUTES.pendingOrders, { signal: options.signal })
  }

  cancelPendingOrders(request: CancelPendingViopOrdersRequest): Promise<ViopOrderCancellationResult> {
    const { signal, idempotencyKey: key, ...body } = request
    return this.http.post<ViopOrderCancellationResult>(ROUTES.cancelOrders, {
      body,
      signal,
      idempotencyKey: key ?? idempotencyKey(),
    })
  }

  exitAllPositions(options: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<ViopPositionExitResult> {
    return this.http.post<ViopPositionExitResult>(ROUTES.exitPositions, {
      body: {},
      signal: options.signal,
      idempotencyKey: options.idempotencyKey ?? idempotencyKey(),
    })
  }

  exitPosition(request: ExitViopPositionRequest): Promise<SubmittedViopPositionExit> {
    const { signal, instrumentUid, idempotencyKey: key, ...body } = request
    return this.http.post<SubmittedViopPositionExit>(ROUTES.exitPosition(instrumentUid), {
      body,
      signal,
      idempotencyKey: key ?? idempotencyKey(),
    })
  }
}

export class HttpAppPreferences {
  private pending: AppPreferences | null = null
  private writing = false

  constructor(private readonly http: HttpClient) {}

  load(): Promise<AppPreferences> {
    return this.http.get<AppPreferences>(ROUTES.appPreferences)
  }

  /**
   * Stores the latest settings, one write at a time.
   *
   * Changes arrive as fast as a trader can press a key. Sent independently they
   * can finish out of order and leave an older layout as the stored one, so a
   * save while another is in flight waits — and only the most recent is sent,
   * since these are last-write-wins and the states in between are not worth a
   * round trip.
   */
  save(preferences: AppPreferences): void {
    this.pending = preferences
    if (this.writing) return
    this.writing = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const body = this.pending
        this.pending = null
        // Preferences are cosmetic; a failed save must not interrupt trading.
        await this.http.put(ROUTES.appPreferences, { body }).catch(() => {})
      }
    } finally {
      this.writing = false
    }
  }
}

export class HttpOverviewSnapshotStore implements OverviewSnapshotStore {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<StoredOverviewSnapshot[]> {
    return this.http.get<StoredOverviewSnapshot[]>(ROUTES.overviewSnapshots)
  }

  async put(snapshot: StoredOverviewSnapshot): Promise<void> {
    await this.http.put(ROUTES.overviewSnapshots, { body: snapshot })
  }
}
