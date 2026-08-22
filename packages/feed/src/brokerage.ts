import { z } from "zod"
import type {
  BrokerageDistribution,
  BrokerageDistributionRequest,
  BrokerageDistributionSource,
  BrokerageShare,
} from "@trbot/market/brokerage.ts"
import { headlineShare } from "./broker-headline.ts"
import { brokerageName, FeedBrokerageDirectory } from "./brokerages.ts"
import type { InstrumentSymbols } from "./instrument-symbols.ts"
import { marketDate } from "./session-hours.ts"
import { withStreamToken, type FeedSession } from "./session.ts"
import { FetchFeedTransport, buildUrl, readJson, type FeedTransport } from "./transport.ts"
import { tradingDayPresets, type FeedTradingDays } from "./trading-days.ts"

/**
 * Which brokerage houses accumulated or distributed a stock over a date range.
 *
 * The feed reports both sides in one reading, signed: a house that bought more
 * than it sold carries a positive net, and a house that did the reverse carries a
 * negative one. The side asked for is therefore a filter over one response
 * rather than a separate request, and the net is reported as a magnitude because
 * the direction already belongs to the side.
 *
 * Figures are published for cash equities only — a contract code answers with an
 * empty reading — so the request's instrument is traded for its underlying first.
 */

export const MARKET_SERVER_BASE = "https://markets.fintables.com/barbar/server"

/**
 * The first day the distribution has anything to say.
 *
 * A data floor rather than a UI bound: GARAN, SAHOL and THYAO each answer with a
 * full reading on 2023-12-01 and with nothing at all on 2023-11-01, and the
 * vendor's own date picker starts on the same day. Days before it are left out of
 * the picker rather than offered and then answered empty — unlike the custody
 * register, which reaches further back.
 */
export const DISTRIBUTION_HISTORY_START = "2023-12-01"

const DistributionSchema = z.object({
  /** The range actually covered, echoed as `YYYY-MM-DD 00:00:00`. */
  start: z.string().nullish(),
  end: z.string().nullish(),
  results: z.array(
    z.object({
      brokerage: z.string(),
      /** Bought minus sold: size in lots, `cost` its volume-weighted price. */
      net: z.object({
        size: z.number(),
        /**
         * Null when there is nothing to average. A house that bought and sold
         * the same amount has no net position and so no price for one, and the
         * feed says so rather than quoting a zero.
         */
        cost: z.number().nullable(),
        /** Share of the side's own total, as a fraction. */
        percentage: z.number(),
      }),
      /** Everything the house traded, whichever way it went. */
      total: z.object({
        size: z.number(),
        volume: z.number(),
        /** Null for the same reason as `net.cost`, on a house that traded nothing. */
        cost: z.number().nullable(),
        percentage: z.number(),
      }),
    }),
  ),
})

/**
 * How long a reading is reused.
 *
 * Both sides come from one response but callers ask for them separately, so
 * without this switching sides would fetch the same reading twice. Short enough
 * that a reading of the open session still keeps up with it.
 */
const READING_TTL_MS = 15_000

type Reading = z.infer<typeof DistributionSchema>

export interface FeedBrokerageDistributionSourceOptions {
  session: Pick<FeedSession, "streamToken" | "renewStreamToken">
  symbols: InstrumentSymbols
  tradingDays: FeedTradingDays
  brokerages: FeedBrokerageDirectory
  transport?: FeedTransport
  baseUrl?: string
  now?: () => number
  ttlMs?: number
}

export class FeedBrokerageDistributionSource implements BrokerageDistributionSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly readings = new Map<string, { reading: Reading; readAt: number }>()
  private readonly loading = new Map<string, Promise<Reading>>()

  constructor(private readonly options: FeedBrokerageDistributionSourceOptions) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? MARKET_SERVER_BASE
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? READING_TTL_MS
  }

  async loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution> {
    const { instrumentUid, side, range, signal } = request
    const symbol = await this.options.symbols.underlyingFor(instrumentUid, signal)
    const sessions = await this.options.tradingDays.list(symbol, signal)
    const dates = sessions.filter((date) => date >= DISTRIBUTION_HISTORY_START)
    // A null start means the current session, which is the newest day the
    // exchange has traded rather than today's date: asking for a Sunday would
    // otherwise read as a session with no trades in it.
    const start = range.start ?? dates[0] ?? marketDate(this.now())
    const end = range.end ?? start

    const reading = await this.read(symbol, start, end, signal)
    const names = await this.options.brokerages.names(signal)
    const wanted = side === "BUYER" ? 1 : -1
    const shares: BrokerageShare[] = reading.results
      .filter((row) => Math.sign(row.net.size) === wanted)
      .map((row) => ({
        brokerage: brokerageName(names, row.brokerage),
        netLots: Math.abs(row.net.size),
        // A null cost belongs to a house with no net position, and the side
        // filter above has already dropped those, so this never stands in for a
        // price the feed actually withheld.
        averagePrice: row.net.cost ?? 0,
        percentage: row.net.percentage * 100,
        grossLots: row.total.size,
        volumeShare: row.total.percentage * 100,
      }))
      .sort((left, right) => right.netLots - left.netLots)

    return {
      side,
      shares,
      ...headlineShare(shares.map((share) => ({ lots: share.netLots, percentage: share.percentage }))),
      lastUpdate: coveredDay(reading.end) ?? end,
      // The reading keeps moving while the session it covers is still trading.
      live: end === marketDate(this.now()),
      presets: tradingDayPresets(dates),
      availableDates: dates,
    }
  }

  /** One reading per range, however many sides ask for it. */
  private async read(symbol: string, start: string, end: string, signal?: AbortSignal): Promise<Reading> {
    const key = `${symbol}|${start}|${end}`
    const cached = this.readings.get(key)
    if (cached && this.now() - cached.readAt < this.ttlMs) return cached.reading
    const pending = this.loading.get(key)
    if (pending) return pending

    const read = withStreamToken(this.options.session, (streamToken) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/akd", { code: symbol, start, end }),
          token: streamToken,
          signal,
        },
        DistributionSchema,
      ),
    )
      .then((reading) => {
        this.readings.set(key, { reading, readAt: this.now() })
        return reading
      })
      .finally(() => {
        this.loading.delete(key)
      })
    this.loading.set(key, read)
    return read
  }
}

/** `2026-08-21 00:00:00` as the day it names. */
function coveredDay(echoed: string | null | undefined): string | null {
  return echoed?.slice(0, 10) ?? null
}
