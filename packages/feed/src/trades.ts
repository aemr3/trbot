import { z } from "zod"
import type { DepthTrade } from "@trbot/market/depth.ts"
import { brokerageName, FeedBrokerageDirectory } from "./brokerages.ts"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"
import type { FeedRecord } from "./value.ts"

/**
 * The trade tape.
 *
 * It arrives over two transports carrying one shape. The feed serves the prints
 * that already happened over HTTP, and pushes each new print over the socket as
 * `{"o": code, "v": {...}}`; the vendor's own client prepends that `v` onto the
 * same list it filled from HTTP. So the schema below is read off the HTTP
 * response — which is observable at any hour — and reused for socket frames.
 *
 * A socket frame that does not match is ignored rather than guessed at, so the
 * worst case is a tape that stops growing, never one that invents a print.
 */

/** One print, exactly as the feed spells it. */
const TradePrintSchema = z.object({
  /** Price. */
  p: z.number(),
  /** Size, in lots. */
  s: z.number(),
  /** Aggressor: `B` bought into the ask, `S` sold into the bid. */
  a: z.string().nullish(),
  /** Buying brokerage code. Null on VIOP, which does not disclose them. */
  bb: z.string().nullish(),
  /** Selling brokerage code. */
  sb: z.string().nullish(),
  /** The feed's own print id. */
  i: z.number(),
  /** Epoch seconds. */
  t: z.number().nullish(),
})

export type TradePrint = z.infer<typeof TradePrintSchema>

const TapeSchema = z.object({
  next: z.string().nullish(),
  previous: z.string().nullish(),
  results: z.array(TradePrintSchema),
})

/** Parses a socket trade frame's payload, or null when it is not a print. */
export function parseTradePrint(payload: FeedRecord): TradePrint | null {
  const parsed = TradePrintSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

export interface FeedTradeSourceOptions {
  transport?: FeedTransport
  baseUrl?: string
  /** The shared directory, so one brokerage read serves every broker feed. */
  brokerages?: FeedBrokerageDirectory
}

/**
 * Reads the tape, and the brokerage names its codes stand for.
 *
 * Prints name their counterparties by short code — `OYA`, `AKM` — which means
 * nothing on screen, so each is rendered through the brokerage directory.
 */
export class FeedTradeSource {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private readonly brokerages: FeedBrokerageDirectory

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    options: FeedTradeSourceOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
    this.brokerages = options.brokerages ?? new FeedBrokerageDirectory(session, options)
  }

  /** The prints already on the tape, most recent first. */
  async listTrades(symbol: string, options: { signal?: AbortSignal } = {}): Promise<DepthTrade[]> {
    const tape = await withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/mobile/orderbook/transactions/", { code: symbol }),
          token,
          signal: options.signal,
        },
        TapeSchema,
      ))
    const names = await this.brokerages.names(options.signal)
    return tape.results.map((print) => toTrade(print, names))
  }
}

/** Turns a print into the tape row the application renders. */
export function toTrade(print: TradePrint, brokerages: Map<string, string>): DepthTrade {
  const name = (code: string | null | undefined): string | null =>
    code ? brokerageName(brokerages, code) : null
  return {
    id: String(print.i),
    price: print.p,
    lots: print.s,
    // `a` names the aggressor, which is what the contract means by side: a buy
    // print crossed into the ask.
    side: print.a?.toUpperCase() === "S" ? "SELL" : "BUY",
    buyer: name(print.bb),
    seller: name(print.sb),
  }
}
