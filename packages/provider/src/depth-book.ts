import type { DepthUpdate } from "@trbot/api/market.ts"
import type { DepthBook, DepthLevel, DepthTrade } from "@trbot/market/depth.ts"

const DEFAULT_MAX_TRADES = 10

// Rebuilds the order book from the provider's frames. The opening frame carries
// every level and the full trade tape; each frame after it is a delta, so levels
// arrive keyed by their slot in the ladder and trades arrive one at a time. Both
// have to be merged into the running book rather than replacing it.
export class DepthBookAccumulator {
  private symbol: string | null = null
  private bids: (DepthLevel | null)[] = []
  private asks: (DepthLevel | null)[] = []
  private buyLots: number | null = null
  private sellLots: number | null = null
  private trades: DepthTrade[] = []
  private maxTrades = DEFAULT_MAX_TRADES
  private marketClosed = false
  private maintenance = false
  private infoMessage: string | null = null

  // Drops the running book. Call when the subscription moves to another symbol
  // so a stale ladder never shows under a new one.
  reset(): void {
    this.symbol = null
    this.bids = []
    this.asks = []
    this.buyLots = null
    this.sellLots = null
    this.trades = []
    this.maxTrades = DEFAULT_MAX_TRADES
    this.marketClosed = false
    this.maintenance = false
    this.infoMessage = null
  }

  apply(update: DepthUpdate): DepthBook {
    if (this.symbol !== update.symbol) {
      this.reset()
      this.symbol = update.symbol
    }
    if (update.depth) {
      this.bids = mergeLevels(this.bids, update.depth.bids)
      this.asks = mergeLevels(this.asks, update.depth.asks)
      if (update.depth.buyLots !== null) this.buyLots = update.depth.buyLots
      if (update.depth.sellLots !== null) this.sellLots = update.depth.sellLots
    }
    if (update.trades) {
      this.maxTrades = update.trades.maxLength ?? this.maxTrades
      this.trades = update.trades.replace
        ? update.trades.items.slice(0, this.maxTrades)
        : mergeTrades(this.trades, update.trades.items, this.maxTrades)
    }
    if (update.marketClosed !== null) this.marketClosed = update.marketClosed
    if (update.maintenance !== null) this.maintenance = update.maintenance
    if (update.infoMessage !== null) this.infoMessage = update.infoMessage
    return this.snapshot()
  }

  snapshot(): DepthBook {
    return {
      symbol: this.symbol ?? "",
      bids: this.bids.filter((level): level is DepthLevel => level !== null),
      asks: this.asks.filter((level): level is DepthLevel => level !== null),
      buyLots: this.buyLots,
      sellLots: this.sellLots,
      trades: this.trades,
      marketClosed: this.marketClosed,
      maintenance: this.maintenance,
      infoMessage: this.infoMessage,
    }
  }
}

// Levels are addressed by their ladder slot, so an update replaces one rung and
// leaves the rest of the side standing.
function mergeLevels(
  current: (DepthLevel | null)[],
  incoming: { index: number; level: DepthLevel }[],
): (DepthLevel | null)[] {
  if (incoming.length === 0) return current
  const merged = [...current]
  for (const { index, level } of incoming) {
    while (merged.length <= index) merged.push(null)
    merged[index] = level
  }
  return merged
}

// The tape is newest-first and capped by the provider. Trades can arrive out of
// order, so incoming prints are merged by id rather than simply unshifted.
function mergeTrades(current: DepthTrade[], incoming: DepthTrade[], maxLength: number): DepthTrade[] {
  if (incoming.length === 0) return current
  const known = new Set(current.map((trade) => trade.id))
  const fresh = incoming.filter((trade) => !known.has(trade.id))
  if (fresh.length === 0) return current
  return [...fresh, ...current].sort((left, right) => compareTradeIds(right.id, left.id)).slice(0, maxLength)
}

// Trade ids are ascending numeric strings; longer ids are always larger.
function compareTradeIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length
  return left < right ? -1 : left > right ? 1 : 0
}
