import { z } from "zod"
import { formatDay } from "@trbot/market/broker-calendar.ts"
import type {
  SettlementAnalysis,
  SettlementHolding,
  SettlementRequest,
  SettlementSource,
} from "@trbot/market/settlement.ts"
import { headlineShare } from "./broker-headline.ts"
import { brokerageName, FeedBrokerageDirectory } from "./brokerages.ts"
import type { InstrumentSymbols } from "./instrument-symbols.ts"
import { marketDate, previousDate } from "./session-hours.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { FetchFeedTransport, buildUrl, readJson, type FeedTransport } from "./transport.ts"
import { tradingDayPresets, type FeedTradingDays } from "./trading-days.ts"

/**
 * What each brokerage house was left holding once a day's trades settled, and
 * what moved over a range.
 *
 * Two endpoints, and the split matters. The register reports standing positions
 * for one day, and the feed **truncates** that list — a day with 124 houses
 * holding stock answers with 44. So a move cannot be measured by differencing two
 * registers: a house that slips past the cut-off looks like it sold everything.
 * The feed's own diff endpoint reads the whole book on both dates, so the move
 * comes from there, and it hands over the standing position and the change in
 * share along with it.
 *
 * The register is only published for cash equities, so the request's instrument
 * is traded for its underlying first.
 */

/** The only index either endpoint reports for a stock: holdings by settlement house. */
const CUSTODIAN_INDEX = "custodian"

const RegisterSchema = z.object({
  /**
   * The day actually reported. The feed answers a day it has not settled with
   * the last one it has, so this is not necessarily the day that was asked for.
   */
  date: z.string().nullable(),
  results: z.array(
    z.object({
      custodian: z.string(),
      /** Lots held at the close of that day. */
      value: z.number(),
      /** Share of the reported total, as a fraction. */
      percentage: z.number(),
    }),
  ),
})

type Register = z.infer<typeof RegisterSchema>

/**
 * The move between two settled days.
 *
 * Percentages here are **already scaled** — `6.196` means 6.196% — where the
 * register above reports the same holding as the fraction `0.0620`. The two
 * endpoints disagree on units, so neither mapping can be shared with the other.
 */
const MovementSchema = z.object({
  /** The settled days actually compared. A date the feed has not settled snaps back. */
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  results: z.array(
    z.object({
      custodian: z.string(),
      /** Lots moved over the range, signed. */
      difference: z.number(),
      /** The position on `start_date`. */
      first_value: z.number(),
      first_percentage: z.number(),
      /** The position on `end_date`, which is what the house holds now. */
      last_value: z.number(),
      last_percentage: z.number(),
      /** The change in share, in percentage points. */
      percentage_change: z.number(),
    }),
  ),
})

type Movement = z.infer<typeof MovementSchema>

/**
 * How long a register is reused.
 *
 * A settled day does not change, and even the current one moves slowly, but the
 * reason for holding them at all is that the three readings overlap: "who added"
 * and "who shed" are the same two registers read twice.
 */
const REGISTER_TTL_MS = 60_000

export interface FeedSettlementSourceOptions {
  session: Pick<FeedSession, "accessToken" | "renewAccessToken">
  symbols: InstrumentSymbols
  tradingDays: FeedTradingDays
  brokerages: FeedBrokerageDirectory
  transport?: FeedTransport
  baseUrl?: string
  now?: () => number
  ttlMs?: number
}

export class FeedSettlementSource implements SettlementSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly registers = new Map<string, { register: Register; readAt: number }>()
  private readonly loading = new Map<string, Promise<Register>>()
  private readonly movements = new Map<string, { movement: Movement; readAt: number }>()
  private readonly loadingMovements = new Map<string, Promise<Movement>>()

  constructor(private readonly options: FeedSettlementSourceOptions) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? REGISTER_TTL_MS
  }

  async loadSettlement(request: SettlementRequest): Promise<SettlementAnalysis> {
    const { instrumentUid, mode, range, signal } = request
    const symbol = await this.options.symbols.underlyingFor(instrumentUid, signal)
    const dates = await this.options.tradingDays.list(symbol, signal)
    // A null range asks for the latest settled day, which the register answers
    // without a date rather than by naming one.
    const requested = range.end ?? range.start ?? null
    const names = await this.options.brokerages.names(signal)

    const reading = mode === "HELD"
      ? await this.readHeld(symbol, requested, names, signal)
      : await this.readMoved(symbol, range.start ?? null, requested, names, mode, signal)

    return {
      mode,
      holdings: reading.holdings,
      ...headlineShare(reading.holdings.map((holding) => ({
        // A held reading ranks by the standing position, a move by the move.
        lots: Math.abs((mode === "HELD" ? holding.totalLot : holding.lotChange) ?? 0),
        percentage: holding.percentage,
      }))),
      lastUpdate: reading.reported,
      // The day's register is still being written while that day is trading.
      live: reading.reported !== null && reading.reported === marketDate(this.now()),
      presets: tradingDayPresets(dates),
      availableDates: dates,
      unavailableMessage: unavailable(requested, reading.reported),
    }
  }

  /** The standing position on one settled day. */
  private async readHeld(
    symbol: string,
    date: string | null,
    names: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<{ holdings: SettlementHolding[]; reported: string | null }> {
    const register = await this.read(symbol, date, signal)
    return { holdings: held(register, names), reported: register.date }
  }

  /**
   * The move over a range, from the feed's own difference.
   *
   * The baseline is the day *before* the range starts, so the range's own first
   * session counts as movement within it. Both dates are sent as ordinary
   * calendar days: the endpoint snaps each back to a settled one and echoes what
   * it used, which saves hunting for the previous trading day here.
   */
  private async readMoved(
    symbol: string,
    from: string | null,
    to: string | null,
    names: Map<string, string>,
    mode: "GAINED" | "LOST",
    signal?: AbortSignal,
  ): Promise<{ holdings: SettlementHolding[]; reported: string | null }> {
    // Anchored on a day the register actually holds, not on today. Today's date
    // would snap back to the last settled day while the baseline stayed a day
    // later than that, collapsing the window to a single day and reporting no
    // movement at all. The register answers this without a date and is cached, so
    // the held reading beside it pays for the lookup once.
    const end = to ?? (await this.read(symbol, null, signal)).date
    if (!end) return { holdings: [], reported: null }
    const movement = await this.readDiff(symbol, previousDate(from ?? end), end, signal)
    return { holdings: moved(movement, names, mode), reported: movement.end_date }
  }

  private async read(symbol: string, date: string | null, signal?: AbortSignal): Promise<Register> {
    const key = `${symbol}|${date ?? "latest"}`
    const cached = this.registers.get(key)
    if (cached && this.now() - cached.readAt < this.ttlMs) return cached.register
    const pending = this.loading.get(key)
    if (pending) return pending

    const read = this.fetch(symbol, date, signal)
      .then((register) => {
        this.registers.set(key, { register, readAt: this.now() })
        return register
      })
      .finally(() => {
        this.loading.delete(key)
      })
    this.loading.set(key, read)
    return read
  }

  /** One movement reading per range, however many sides ask for it. */
  private async readDiff(
    symbol: string,
    start: string,
    end: string,
    signal?: AbortSignal,
  ): Promise<Movement> {
    const key = `${symbol}|${start}|${end}`
    const cached = this.movements.get(key)
    if (cached && this.now() - cached.readAt < this.ttlMs) return cached.movement
    const pending = this.loadingMovements.get(key)
    if (pending) return pending

    // The request is built in a helper so that awaiting the token cannot suspend
    // before the in-flight promise is registered: two sides asking at once have
    // to share one read.
    const read = this.fetchDiff(symbol, start, end, signal)
      .then((movement) => {
        this.movements.set(key, { movement, readAt: this.now() })
        return movement
      })
      .finally(() => {
        this.loadingMovements.delete(key)
      })
    this.loadingMovements.set(key, read)
    return read
  }

  private async fetchDiff(symbol: string, start: string, end: string, signal?: AbortSignal): Promise<Movement> {
    return withAccessToken(this.options.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/mobile/custodies/diff/", {
            index: CUSTODIAN_INDEX,
            code: symbol,
            start,
            end,
          }),
          token,
          signal,
        },
        MovementSchema,
      ))
  }

  private async fetch(symbol: string, date: string | null, signal?: AbortSignal): Promise<Register> {
    return withAccessToken(this.options.session, (token) =>
      readJson(
        this.transport,
        {
          // Naming no date is how the latest settled day is asked for.
          url: buildUrl(this.baseUrl, "/mobile/custodies/", {
            index: CUSTODIAN_INDEX,
            code: symbol,
            date: date ?? undefined,
          }),
          token,
          signal,
        },
        RegisterSchema,
      ))
  }
}

/** The standing position, ranked by size. */
function held(register: Register, names: Map<string, string>): SettlementHolding[] {
  return register.results
    .map((row) => ({
      brokerage: brokerageName(names, row.custodian),
      percentage: row.percentage * 100,
      percentageChange: null,
      lotChange: null,
      totalLot: row.value,
    }))
    .sort((left, right) => (right.totalLot ?? 0) - (left.totalLot ?? 0))
}

/**
 * The move over a range, keeping only the side the mode names.
 *
 * `percentage` is each house's share of the move rather than of the market: on a
 * table of houses that added lots, the question the column answers is how much of
 * that buying was theirs. `percentageChange` is the feed's own figure, already in
 * percentage points, and `totalLot` is where the house ended up.
 */
function moved(movement: Movement, names: Map<string, string>, mode: "GAINED" | "LOST"): SettlementHolding[] {
  const wanted = mode === "GAINED" ? 1 : -1
  const moves = movement.results
    .filter((row) => Math.sign(row.difference) === wanted)
    .sort((left, right) => Math.abs(right.difference) - Math.abs(left.difference))

  const total = moves.reduce((sum, move) => sum + Math.abs(move.difference), 0)
  return moves.map((move) => ({
    brokerage: brokerageName(names, move.custodian),
    percentage: total === 0 ? 0 : (Math.abs(move.difference) / total) * 100,
    percentageChange: move.percentage_change,
    lotChange: move.difference,
    totalLot: move.last_value,
  }))
}

/**
 * Says so when the register asked for has not been published.
 *
 * The feed answers such a day with the last one it has settled, so without this
 * the panel would show yesterday's figures under today's heading.
 */
function unavailable(requested: string | null, reported: string | null): string | null {
  if (!requested || !reported || requested === reported) return null
  return `Settlement for ${formatDay(requested)} is not published yet — showing ${formatDay(reported)}.`
}
