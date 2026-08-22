import { z } from "zod"

export const INSTRUMENT_MARKET_KINDS = ["equity", "index", "currency", "commodity", "other"] as const
export type InstrumentMarketKind = (typeof INSTRUMENT_MARKET_KINDS)[number]

export interface InstrumentMarketDataAvailability {
  /** The feed carries candles for the VİOP contract itself. */
  instrumentCandles: boolean
  /** The exact cash, spot, or index symbol the feed carries, when one exists. */
  underlyingSymbol: string | null
  underlyingKind: InstrumentMarketKind | null
  /** Broker distribution and settlement registers are published only for cash equities. */
  brokerAnalytics: boolean
}

export const InstrumentMarketDataAvailabilitySchema: z.ZodType<InstrumentMarketDataAvailability> = z.object({
  instrumentCandles: z.boolean(),
  underlyingSymbol: z.string().min(1).nullable(),
  underlyingKind: z.enum(INSTRUMENT_MARKET_KINDS).nullable(),
  brokerAnalytics: z.boolean(),
})

export interface ViopInstrument {
  uid: string
  symbol: string
  displayName: string
  underlyingSymbol: string | null
  lastPrice: number | null
  changePercent: number | null
  volume: number | null
  currency: string
  /** Present after the server has compared the contract with the market-data feed's universes. */
  marketData?: InstrumentMarketDataAvailability
}

export const ViopInstrumentSchema: z.ZodType<ViopInstrument> = z.object({
  uid: z.string(),
  symbol: z.string(),
  displayName: z.string(),
  underlyingSymbol: z.string().nullable(),
  lastPrice: z.number().nullable(),
  changePercent: z.number().nullable(),
  volume: z.number().nullable(),
  currency: z.string(),
  marketData: InstrumentMarketDataAvailabilitySchema.optional(),
})

export interface ViopContractDetails {
  initialCollateral: number | null
  leverage: number | null
  contractSize: number | null
  expiryDate: string | null
  sessionHigh: number | null
  sessionLow: number | null
  settlementPrice: number | null
  previousSettlementPrice: number | null
  volume: number | null
  openInterest: number | null
}

export const ViopContractDetailsSchema: z.ZodType<ViopContractDetails> = z.object({
  initialCollateral: z.number().nullable(),
  leverage: z.number().nullable(),
  contractSize: z.number().nullable(),
  expiryDate: z.string().nullable(),
  sessionHigh: z.number().nullable(),
  sessionLow: z.number().nullable(),
  settlementPrice: z.number().nullable(),
  previousSettlementPrice: z.number().nullable(),
  volume: z.number().nullable(),
  openInterest: z.number().nullable(),
})

export interface ViopInstrumentSource {
  listInstruments(options?: { signal?: AbortSignal }): Promise<ViopInstrument[]>
  loadContractDetails?(instrumentUid: string, options?: { signal?: AbortSignal }): Promise<ViopContractDetails>
}

/** Resolves either a contract symbol or its underlying alias from an active instrument list. */
export function resolveViopInstrument(instruments: ViopInstrument[], rawSymbol: string): ViopInstrument {
  const wanted = rawSymbol.trim().toUpperCase()
  const matches = instruments.filter((instrument) => [
    instrument.symbol,
    instrument.displayName,
    instrument.underlyingSymbol,
  ].some((name) => name?.toUpperCase() === wanted))
  if (matches.length === 0) {
    throw new Error(
      `No active VIOP contract found for ${rawSymbol}. Only nearest-expiry contracts are available; use an exact listed contract or its underlying symbol instead of constructing an expiry code.`,
    )
  }
  if (matches.length > 1) {
    throw new Error(`More than one contract matched ${rawSymbol}: ${matches.map((item) => item.symbol).join(", ")}`)
  }
  return matches[0]!
}

// What one contract costs to hold: the notional it controls and the collateral
// it ties up. Both are wanted in more than one place, and the notional moves
// with every tick, so the arithmetic lives here rather than in a renderer.
export interface ContractOrderCost {
  // Last price times contract size: what a single contract is exposure to.
  notional: number | null
  // Collateral one contract requires.
  required: number | null
  currency: string
}

export function contractOrderCost(instrument: ViopInstrument, details: ViopContractDetails): ContractOrderCost {
  return {
    notional: instrument.lastPrice !== null && details.contractSize !== null
      ? instrument.lastPrice * details.contractSize
      : null,
    required: details.initialCollateral,
    currency: instrument.currency,
  }
}
