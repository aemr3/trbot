import type {
  IndexContribution,
  IndexImpactCode,
  IndexImpactSnapshot,
  IndexImpactSource,
} from "@trbot/market/index-impact.ts"
import { z } from "zod"
import { FEED_FIELDS, topic } from "./fields.ts"
import type { FieldUpdate, SocketSubscriber } from "./socket.ts"
import {
  FeedResponseError,
  FetchFeedTransport,
  readText,
  type FeedTransport,
} from "./transport.ts"
import { asNumber } from "./value.ts"

export const MARKET_SITE_BASE = "https://fintables.com"

const BROAD_MARKET_CODE = "XUTUM"
const DEFAULT_CACHE_TTL_MS = 15 * 60_000
const DEFAULT_SNAPSHOT_SETTLE_MS = 1_000
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10_000

const EmbeddedWeightsSchema = z.object({
  title: z.string().min(1),
  code: z.string().min(1),
  weights: z.record(z.string().min(1), z.number().nonnegative()),
  updated_at: z.string().min(1),
})

type EmbeddedWeights = z.output<typeof EmbeddedWeightsSchema>

interface WeightPage {
  index: EmbeddedWeights
  broadMarket: EmbeddedWeights
}

interface QuoteState {
  lastPrice: number | null
  previousClose: number | null
  volume: number | null
  timestamp: number | null
}

export interface FeedIndexImpactSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
  now?: () => number
  cacheTtlMs?: number
  snapshotSettleMs?: number
  snapshotTimeoutMs?: number
  onLicenseTaken?: () => void
}

/**
 * Reads published index weights and combines them with one bounded snapshot from
 * the process-wide realtime socket. No second licensed connection is opened.
 */
export class FeedIndexImpactSource implements IndexImpactSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly snapshotSettleMs: number
  private readonly snapshotTimeoutMs: number
  private readonly cache = new Map<IndexImpactCode, { loadedAt: number; page: WeightPage }>()

  constructor(
    private readonly socket: SocketSubscriber,
    private readonly options: FeedIndexImpactSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? MARKET_SITE_BASE
    this.now = options.now ?? (() => Date.now())
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.snapshotSettleMs = options.snapshotSettleMs ?? DEFAULT_SNAPSHOT_SETTLE_MS
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS
  }

  async loadIndexImpact(
    index: IndexImpactCode,
    options: { signal?: AbortSignal } = {},
  ): Promise<IndexImpactSnapshot> {
    const page = await this.loadWeightPage(index, options.signal)
    return this.readSnapshot(page, options.signal)
  }

  private async loadWeightPage(index: IndexImpactCode, signal?: AbortSignal): Promise<WeightPage> {
    const cached = this.cache.get(index)
    if (cached && this.now() - cached.loadedAt < this.cacheTtlMs) return cached.page

    const page = await this.fetchWeightPage(index, signal)
    this.cache.set(index, { loadedAt: this.now(), page })
    return page
  }

  private async fetchWeightPage(index: IndexImpactCode, signal?: AbortSignal): Promise<WeightPage> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/endeksler/${index}`
    const body = await readText(this.transport, { url, signal })
    const selected = readEmbeddedWeights(body, "index", url)
    const broadMarket = readEmbeddedWeights(body, "xutum", url)
    if (selected.code !== index) {
      throw new FeedResponseError(url, `expected index ${index}, received ${selected.code}`)
    }
    if (broadMarket.code !== BROAD_MARKET_CODE) {
      throw new FeedResponseError(url, `expected broad-market index ${BROAD_MARKET_CODE}, received ${broadMarket.code}`)
    }
    return { index: selected, broadMarket }
  }

  private readSnapshot(page: WeightPage, signal?: AbortSignal): Promise<IndexImpactSnapshot> {
    const members = Object.keys(page.index.weights)
    const symbols = [...new Set([page.index.code, page.broadMarket.code, ...members])]
    const states = new Map(symbols.map((symbol) => [symbol, emptyQuote()]))
    const topics = new Set<string>([
      topic(page.index.code, FEED_FIELDS.CLOSE),
      topic(page.index.code, FEED_FIELDS.PREVIOUS_CLOSE),
      topic(page.index.code, FEED_FIELDS.TIMESTAMP),
      topic(page.broadMarket.code, FEED_FIELDS.CLOSE),
      topic(page.broadMarket.code, FEED_FIELDS.PREVIOUS_CLOSE),
    ])
    for (const symbol of members) {
      topics.add(topic(symbol, FEED_FIELDS.CLOSE))
      topics.add(topic(symbol, FEED_FIELDS.PREVIOUS_CLOSE))
      topics.add(topic(symbol, FEED_FIELDS.VOLUME))
    }

    return new Promise<IndexImpactSnapshot>((resolve, reject) => {
      let settled = false
      let release: (() => void) | null = null
      let releaseWhenReady = false
      let partialTimer: ReturnType<typeof setTimeout> | null = null

      const stop = (): void => {
        if (release) release()
        else releaseWhenReady = true
      }
      const finish = (result: { snapshot: IndexImpactSnapshot } | { error: Error }): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (partialTimer) clearTimeout(partialTimer)
        signal?.removeEventListener("abort", onAbort)
        stop()
        if ("snapshot" in result) resolve(result.snapshot)
        else reject(result.error)
      }
      const finishIfUsable = (): boolean => {
        if (!hasBaselines(states, page)) return false
        finish({ snapshot: buildSnapshot(page, states, this.now()) })
        return true
      }
      const onAbort = (): void => finish({ error: new Error("Index-impact request was cancelled") })
      const timeoutTimer = setTimeout(() => {
        if (finishIfUsable()) return
        finish({ error: new Error(`Timed out waiting for ${page.index.code} index-impact data`) })
      }, this.snapshotTimeoutMs)

      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      release = this.socket.subscribe([...topics], {
        onFields: (updates) => {
          applyFields(states, updates)
          if (hasCompleteQuotes(states, symbols)) {
            finish({ snapshot: buildSnapshot(page, states, this.now()) })
            return
          }
          if (partialTimer) return
          partialTimer = setTimeout(() => {
            partialTimer = null
            finishIfUsable()
          }, this.snapshotSettleMs)
        },
        onLicenseTaken: () => {
          this.options.onLicenseTaken?.()
          finish({ error: new Error("Realtime market-data license was claimed by another device") })
        },
      })
      if (releaseWhenReady) release()
    })
  }
}

function emptyQuote(): QuoteState {
  return { lastPrice: null, previousClose: null, volume: null, timestamp: null }
}

function applyFields(states: Map<string, QuoteState>, updates: FieldUpdate[]): void {
  for (const update of updates) {
    const state = states.get(update.symbol)
    if (!state) continue
    switch (update.field) {
      case FEED_FIELDS.CLOSE:
        state.lastPrice = asNumber(update.value)
        break
      case FEED_FIELDS.PREVIOUS_CLOSE:
        state.previousClose = asNumber(update.value)
        break
      case FEED_FIELDS.VOLUME:
        state.volume = asNumber(update.value)
        break
      case FEED_FIELDS.TIMESTAMP:
        state.timestamp = asNumber(update.value)
        break
    }
  }
}

function hasCompleteQuotes(states: Map<string, QuoteState>, symbols: string[]): boolean {
  return symbols.every((symbol) => {
    const state = states.get(symbol)
    return state?.lastPrice !== null && state?.previousClose !== null
  })
}

function hasBaselines(states: Map<string, QuoteState>, page: WeightPage): boolean {
  return [page.index.code, page.broadMarket.code].every((symbol) => {
    const state = states.get(symbol)
    return state?.lastPrice !== null && state?.previousClose !== null
  })
}

function buildSnapshot(
  page: WeightPage,
  states: Map<string, QuoteState>,
  readAt: number,
): IndexImpactSnapshot {
  const indexState = completeBaseline(states, page.index.code)
  const broadState = completeBaseline(states, page.broadMarket.code)
  const contributions = Object.entries(page.index.weights).map(([symbol, weightPercent]) => {
    const state = states.get(symbol) ?? emptyQuote()
    const ratio = priceChange(state.lastPrice, state.previousClose)
    const broadMarketWeightPercent = page.broadMarket.weights[symbol] ?? null
    const contribution: IndexContribution = {
      symbol,
      lastPrice: state.lastPrice,
      previousClose: state.previousClose,
      changePercent: ratio === null ? null : ratio * 100,
      volume: state.volume,
      weightPercent,
      impactPoints: ratio === null ? null : indexState.previousClose * weightPercent / 100 * ratio,
      broadMarketWeightPercent,
      broadMarketImpactPoints: ratio === null || broadMarketWeightPercent === null
        ? null
        : broadState.previousClose * broadMarketWeightPercent / 100 * ratio,
    }
    return contribution
  }).sort(compareImpact)

  const available = contributions.filter((contribution) => contribution.changePercent !== null)
  const indexRatio = priceChange(indexState.lastPrice, indexState.previousClose) ?? 0
  const broadRatio = priceChange(broadState.lastPrice, broadState.previousClose) ?? 0
  return {
    readAt,
    marketTimestamp: indexState.timestamp === null ? null : indexState.timestamp * 1_000,
    weightsUpdatedAt: page.index.updated_at,
    index: {
      code: page.index.code,
      title: page.index.title,
      lastPrice: indexState.lastPrice,
      previousClose: indexState.previousClose,
      changePercent: indexRatio * 100,
      pointChange: indexState.lastPrice - indexState.previousClose,
    },
    breadth: {
      advancing: available.filter((contribution) => contribution.changePercent! > 0).length,
      unchanged: available.filter((contribution) => contribution.changePercent === 0).length,
      declining: available.filter((contribution) => contribution.changePercent! < 0).length,
      unavailable: contributions.length - available.length,
    },
    estimatedConstituentImpactPoints: sum(contributions.map((contribution) => contribution.impactPoints)),
    broadMarket: {
      code: page.broadMarket.code,
      title: page.broadMarket.title,
      weightsUpdatedAt: page.broadMarket.updated_at,
      lastPrice: broadState.lastPrice,
      previousClose: broadState.previousClose,
      changePercent: broadRatio * 100,
      pointChange: broadState.lastPrice - broadState.previousClose,
      impactPoints: sum(contributions.map((contribution) => contribution.broadMarketImpactPoints)),
    },
    contributions,
  }
}

function completeBaseline(states: Map<string, QuoteState>, symbol: string): QuoteState & {
  lastPrice: number
  previousClose: number
} {
  const state = states.get(symbol)
  if (!state || state.lastPrice === null || state.previousClose === null) {
    throw new Error(`Missing price baseline for ${symbol}`)
  }
  return { ...state, lastPrice: state.lastPrice, previousClose: state.previousClose }
}

function priceChange(lastPrice: number | null, previousClose: number | null): number | null {
  if (lastPrice === null || previousClose === null || previousClose === 0) return null
  return lastPrice / previousClose - 1
}

function compareImpact(left: IndexContribution, right: IndexContribution): number {
  if (left.impactPoints === null) return right.impactPoints === null ? left.symbol.localeCompare(right.symbol) : 1
  if (right.impactPoints === null) return -1
  return Math.abs(right.impactPoints) - Math.abs(left.impactPoints) || left.symbol.localeCompare(right.symbol)
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

function readEmbeddedWeights(body: string, key: "index" | "xutum", url: string): EmbeddedWeights {
  const marker = `\\"${key}\\":`
  const markerStart = body.indexOf(marker)
  const objectStart = markerStart < 0 ? -1 : body.indexOf("{", markerStart + marker.length)
  if (objectStart < 0) throw new FeedResponseError(url, `missing embedded ${key} weights`)

  let depth = 0
  let objectEnd = -1
  for (let index = objectStart; index < body.length; index++) {
    if (body[index] === "{") depth++
    else if (body[index] === "}" && --depth === 0) {
      objectEnd = index + 1
      break
    }
  }
  if (objectEnd < 0) throw new FeedResponseError(url, `unterminated embedded ${key} weights`)

  try {
    const decoded: unknown = JSON.parse(body.slice(objectStart, objectEnd).replaceAll('\\"', '"'))
    const parsed = EmbeddedWeightsSchema.safeParse(decoded)
    if (parsed.success) return parsed.data
    throw new Error(z.prettifyError(parsed.error))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new FeedResponseError(url, `invalid embedded ${key} weights: ${detail}`)
  }
}
