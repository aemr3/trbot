import { z } from "zod"
import {
  DEFAULT_INTERVALS_BY_RANGE,
  type Candle,
  type CandleInterval,
  type CandleIntervalsByRange,
  type CandleRange,
  type CandleSeries,
  type CandleSource,
} from "@trbot/market/candle.ts"
import { aggregateByCalendar, aggregateByDuration } from "./aggregate.ts"
import type { CalendarPeriod } from "@trbot/market/calendar.ts"
import { FeedSession, withStreamToken } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

export const MARKET_DATA_BASE = "https://markets.fintables.com/barbar/udf"

/**
 * The grains the feed actually serves.
 *
 * Its `supported_resolutions` also advertises `30`, `240`, `W`, and `M`, and all
 * four are rejected with HTTP 400. The symbol's `intraday_multipliers` is the
 * honest list, and this matches it. Every other grain is folded from these.
 */
const NATIVE_RESOLUTION = new Map<CandleInterval, string>([
  ["MIN_1", "1"],
  ["MIN_5", "5"],
  ["MIN_15", "15"],
  ["HOUR_1", "60"],
  ["DAY_1", "D"],
])

const INTERVAL_MS = new Map<CandleInterval, number>([
  ["MIN_1", 60_000],
  ["MIN_5", 5 * 60_000],
  ["MIN_15", 15 * 60_000],
  ["MIN_30", 30 * 60_000],
  ["HOUR_1", 60 * 60_000],
  ["HOUR_4", 4 * 60 * 60_000],
  ["DAY_1", 24 * 60 * 60_000],
  ["WEEK_1", 7 * 24 * 60 * 60_000],
  ["MONTH_1", 30 * 24 * 60 * 60_000],
])

/** How a grain the feed will not serve is built from one it will. */
interface Derivation {
  source: CandleInterval
  /** Fixed-width folding, for grains that are a whole number of source bars. */
  bucketMs?: number
  /** Calendar folding, for periods that are not a fixed width. */
  period?: CalendarPeriod
  /** Source bars per folded bar, used to size the request. */
  sourceBarsPerBar: number
}

const DERIVATIONS = new Map<CandleInterval, Derivation>([
  ["MIN_30", { source: "MIN_15", bucketMs: 30 * 60_000, sourceBarsPerBar: 2 }],
  ["HOUR_4", { source: "HOUR_1", bucketMs: 4 * 60 * 60_000, sourceBarsPerBar: 4 }],
  ["WEEK_1", { source: "DAY_1", period: "week", sourceBarsPerBar: 5 }],
  ["MONTH_1", { source: "DAY_1", period: "month", sourceBarsPerBar: 22 }],
])

/**
 * Every range serves every grain.
 *
 * The brokerage feed served one fixed grain per range, which is why the chart
 * used to pick the timeframe for you. This feed has no such constraint, so range
 * and timeframe are independent — the data simply runs out where it runs out,
 * since intraday history is capped server-side well short of the daily history.
 */
export const FEED_INTERVALS_BY_RANGE: CandleIntervalsByRange = DEFAULT_INTERVALS_BY_RANGE

/** How far back each range reaches, in seconds. */
const RANGE_LOOKBACK_SECONDS = {
  INTRADAY: 24 * 60 * 60,
  WEEK: 7 * 24 * 60 * 60,
  MONTH: 31 * 24 * 60 * 60,
  THREE_MONTH: 93 * 24 * 60 * 60,
  YEAR: 366 * 24 * 60 * 60,
  FIVE_YEAR: 5 * 366 * 24 * 60 * 60,
  // Further back than any listing the feed carries; daily history starts in 2005.
  ALL: 40 * 366 * 24 * 60 * 60,
} satisfies Record<CandleRange, number>

/** Trading sessions each range is meant to cover. */
const RANGE_SESSIONS = {
  INTRADAY: 1,
  WEEK: 5,
  MONTH: 22,
  THREE_MONTH: 66,
  YEAR: 252,
  FIVE_YEAR: 1260,
  ALL: 6_000,
} satisfies Record<CandleRange, number>

/** Minutes in a session, taken from the longest BIST trading day. */
const SESSION_MINUTES = 530

/**
 * Sessions one bar covers, for the grains coarser than a session.
 *
 * Stated rather than derived: a daily bar spans one session, not the 2.7 that
 * dividing 24 calendar hours by a session's length would suggest.
 */
const SESSIONS_PER_BAR = new Map<CandleInterval, number>([
  ["DAY_1", 1],
  ["WEEK_1", 5],
  ["MONTH_1", 22],
])

/** The most bars one request may ask for. */
const MAX_COUNTBACK = 20_000

/**
 * Bars to ask for, so a range shows the span it names.
 *
 * `countback` takes precedence over the from/to window, so a fixed number would
 * make a one-day chart reach back over several sessions at a fine grain. It is
 * still preferred over relying on the window alone: it guarantees a series even
 * when the market has been closed all weekend, and the rules reading these
 * candles need a minimum number of closed bars to mean anything.
 *
 * A session is far shorter than a calendar day, so bars are counted in session
 * time rather than by dividing the range's wall-clock lookback.
 */
export function countbackFor(range: CandleRange, interval: CandleInterval): number {
  const sessions = RANGE_SESSIONS[range]
  const perBar = SESSIONS_PER_BAR.get(interval)
  const intervalMs = INTERVAL_MS.get(interval)
  if (perBar === undefined && intervalMs === undefined) return 200

  const bars = perBar !== undefined
    ? Math.ceil(sessions / perBar)
    : sessions * Math.ceil(SESSION_MINUTES / ((intervalMs ?? 0) / 60_000))

  // The floor is two bars, enough to read a close against the one before it. It
  // is deliberately not an indicator's window: a coarse grain under a short range
  // — a monthly bar over one session — would then pull sixty months and draw five
  // years under a heading that says one day. Every natural pairing of range and
  // grain already yields hundreds of bars, so an indicator is only ever short of
  // data on a pairing that asked for less than it needs.
  return Math.min(3_000, Math.max(2, bars))
}

// The feed answers in column form: one array per field, aligned by index.
//
// Every column tolerates nulls on purpose. This is an external protocol, and a
// single malformed bar must not reject the whole response and blank a chart —
// `toCandles` drops the offending row instead.
const HistorySchema = z.object({
  s: z.string(),
  errmsg: z.string().optional(),
  t: z.array(z.number().nullable()).optional(),
  o: z.array(z.number().nullable()).optional(),
  h: z.array(z.number().nullable()).optional(),
  l: z.array(z.number().nullable()).optional(),
  c: z.array(z.number().nullable()).optional(),
  v: z.array(z.number().nullable()).optional(),
})

const SymbolInfoSchema = z.object({
  ticker: z.string().optional(),
  session: z.string().optional(),
  timezone: z.string().optional(),
  currency_code: z.string().optional(),
  data_status: z.string().optional(),
  delay: z.number().optional(),
  pricescale: z.number().optional(),
})

export interface FeedSymbolInfo {
  symbol: string
  session: string | null
  timezone: string | null
  currency: string | null
  /** Seconds the feed is behind: 0 once the license is accepted, 900 without it. */
  delaySeconds: number | null
  delayed: boolean
  priceScale: number | null
}

export class FeedDataUnavailableError extends Error {
  constructor(readonly symbol: string, readonly detail: string | null) {
    super(`No candles available for ${symbol}${detail ? `: ${detail}` : ""}`)
    this.name = "FeedDataUnavailableError"
  }
}

export interface FeedCandleSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
  now?: () => number
}

/**
 * Candles from the market data feed.
 *
 * Every request carries the license token, which is what makes the series live
 * rather than delayed by a quarter of an hour. A rejected license is renewed and
 * the read retried once, so a subscription change does not surface as a gap.
 */
export class FeedCandleSource implements CandleSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private readonly now: () => number
  private readonly symbolInfo = new Map<string, FeedSymbolInfo>()

  constructor(
    private readonly session: FeedSession,
    options: FeedCandleSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? MARKET_DATA_BASE
    this.now = options.now ?? (() => Date.now())
  }

  async loadCandles(
    symbol: string,
    range: CandleRange,
    interval: CandleInterval,
    options: { signal?: AbortSignal } = {},
  ): Promise<CandleSeries> {
    const derivation = DERIVATIONS.get(interval)
    const resolution = NATIVE_RESOLUTION.get(derivation?.source ?? interval)
    if (!resolution) throw new FeedDataUnavailableError(symbol, `unsupported interval ${interval}`)

    const countback = countbackFor(range, interval) * (derivation?.sourceBarsPerBar ?? 1)
    const history = await this.readHistory(symbol, resolution, range, countback, options.signal)
    if (history.s === "error") throw new FeedDataUnavailableError(symbol, history.errmsg ?? null)

    const source = history.s === "no_data" ? [] : toCandles(history)
    const info = await this.loadSymbolInfo(symbol, options.signal)

    return {
      instrumentUid: symbol,
      range,
      interval,
      candles: derivation ? fold(source, derivation) : source,
      availableIntervalsByRange: FEED_INTERVALS_BY_RANGE,
      intervalMs: INTERVAL_MS.get(interval) ?? null,
      calendarPeriod: derivation?.period ?? null,
      currency: info?.currency ?? null,
    }
  }

  private async readHistory(
    symbol: string,
    resolution: string,
    range: CandleRange,
    countback: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof HistorySchema>> {
    const to = Math.floor(this.now() / 1000)
    const from = to - RANGE_LOOKBACK_SECONDS[range]
    return withStreamToken(this.session, (streamToken) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/history", {
            symbol,
            resolution,
            from,
            to,
            countback: Math.min(MAX_COUNTBACK, countback),
            currencyCode: "TRY",
          }),
          token: streamToken,
          signal,
        },
        HistorySchema,
      ),
    )
  }

  /**
   * Symbol metadata, cached per symbol. Session hours and the delay flag do not
   * change within a run, and this is read on every candle load.
   */
  async loadSymbolInfo(symbol: string, signal?: AbortSignal): Promise<FeedSymbolInfo | null> {
    const cached = this.symbolInfo.get(symbol)
    if (cached) return cached

    const parsed = await withStreamToken(this.session, (streamToken) =>
      readJson(
        this.transport,
        { url: buildUrl(this.baseUrl, "/symbols", { symbol }), token: streamToken, signal },
        SymbolInfoSchema,
      ),
    )

    const info: FeedSymbolInfo = {
      symbol,
      session: parsed.session ?? null,
      timezone: parsed.timezone ?? null,
      currency: parsed.currency_code ?? null,
      delaySeconds: parsed.delay ?? null,
      delayed: (parsed.delay ?? 0) > 0,
      priceScale: parsed.pricescale ?? null,
    }
    this.symbolInfo.set(symbol, info)
    return info
  }
}

/** Builds a grain the feed will not serve out of one it will. */
function fold(candles: Candle[], derivation: Derivation): Candle[] {
  if (derivation.period) return aggregateByCalendar(candles, derivation.period)
  return derivation.bucketMs ? aggregateByDuration(candles, derivation.bucketMs) : candles
}

/** Turns the column arrays into candles, dropping any row that is not fully formed. */
function toCandles(history: z.infer<typeof HistorySchema>): Candle[] {
  const { t = [], o = [], h = [], l = [], c = [], v = [] } = history
  const candles: Candle[] = []
  for (let index = 0; index < t.length; index++) {
    const timestamp = t[index]
    const open = o[index]
    const high = h[index]
    const low = l[index]
    const close = c[index]
    if (![timestamp, open, high, low, close].every((value) => Number.isFinite(value))) continue
    // Narrowed by the finiteness check above; null and undefined are excluded.
    if (timestamp === null || open === null || high === null || low === null || close === null) continue
    if (timestamp === undefined || open === undefined || high === undefined) continue
    if (low === undefined || close === undefined) continue
    if (high < low) continue
    const volume = v[index]
    candles.push({
      // The feed timestamps bars in seconds; the rest of the app works in millis.
      timestamp: timestamp * 1000,
      open,
      high,
      low,
      close,
      volume: volume !== undefined && volume !== null && Number.isFinite(volume) ? volume : null,
    })
  }
  return candles.sort((left, right) => left.timestamp - right.timestamp)
}
