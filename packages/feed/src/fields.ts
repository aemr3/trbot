/**
 * Wire field codes used by the realtime feed.
 *
 * The feed addresses values as `<CODE>/<FIELD>` topics and pushes deltas keyed
 * the same way, so these short codes are protocol, not naming choices.
 */
export const FEED_FIELDS = {
  TIMESTAMP: "T",
  STATUS: "d",
  CHANGE_PERCENT: "CP",
  OPEN: "O",
  /** Previous close: the baseline change percent is measured against, not today's close. */
  PREVIOUS_CLOSE: "P",
  /** Last traded price. */
  CLOSE: "C",
  LOW: "L",
  HIGH: "H",
  CEILING: "J",
  FLOOR: "K",
  ASK: "A",
  BID: "B",
  WEIGHTED_AVERAGE: "U",
  VOLUME: "V",
  LOTS: "M",
  AUCTION_PRICE: "AC",
  AUCTION_CHANGE_PERCENT: "ACP",
  AUCTION_SIZE: "AD",
  AUCTION_REMAINING_ASK: "AG",
  AUCTION_REMAINING_BID: "AF",
  DEPTH_10: "ob-10",
  BID_TOTAL_VOLUME: "BV",
  BID_WEIGHTED_AVERAGE: "BW",
  ASK_TOTAL_VOLUME: "AV",
  ASK_WEIGHTED_AVERAGE: "AW",
  MARKET_MAKER_ASK: "MA",
  MARKET_MAKER_BID: "MB",
} as const

export type FeedField = (typeof FEED_FIELDS)[keyof typeof FEED_FIELDS]

/** The fields a price quote needs. */
export const QUOTE_FIELDS: FeedField[] = [
  FEED_FIELDS.CLOSE,
  FEED_FIELDS.PREVIOUS_CLOSE,
  FEED_FIELDS.ASK,
  FEED_FIELDS.BID,
  FEED_FIELDS.STATUS,
  FEED_FIELDS.TIMESTAMP,
]

/** The fields the order book needs. */
export const DEPTH_FIELDS: FeedField[] = [
  FEED_FIELDS.DEPTH_10,
  FEED_FIELDS.BID_TOTAL_VOLUME,
  FEED_FIELDS.ASK_TOTAL_VOLUME,
]

export function topic(symbol: string, field: FeedField): string {
  return `${symbol}/${field}`
}

/**
 * Splits a delta key back into symbol and field.
 *
 * Subscription acknowledgements echo topics namespaced by entitlement — `r/` for
 * realtime, so `r/GARAN/C` — while deltas arrive bare as `GARAN/C`. Tolerating
 * the prefix here keeps that difference from leaking into callers.
 */
export function parseTopic(key: string): { symbol: string; field: string } | null {
  const parts = key.split("/")
  if (parts.length === 3) parts.shift()
  if (parts.length !== 2) return null
  const [symbol, field] = parts
  if (!symbol || !field) return null
  return { symbol, field }
}
