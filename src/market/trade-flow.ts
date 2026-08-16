import type { DepthBook } from "./depth.ts"

// A house's session totals on the trade tape. Bought and sold count the lots
// the house printed on each side; net is bought minus sold.
export interface BrokerTradeFlow {
  brokerage: string
  boughtLots: number
  soldLots: number
  netLots: number
}

export interface TradeFlowSummary {
  tradeCount: number
  // Lots whose aggressor crossed the spread on each side.
  aggressorBuyLots: number
  aggressorSellLots: number
  // Ranked by absolute net lots, largest first.
  brokers: BrokerTradeFlow[]
}

interface BrokerTotals {
  boughtLots: number
  soldLots: number
}

// Accumulates per-broker flow from the session's trade tape. The depth stream
// caps each book at the newest handful of trades, so the running totals have to
// be kept here: every emission is scanned and only trades with unseen ids are
// counted, letting overlapping windows arrive without double counting.
export class TradeFlowAccumulator {
  private readonly seen = new Set<string>()
  private readonly brokers = new Map<string, BrokerTotals>()
  private tradeCount = 0
  private aggressorBuyLots = 0
  private aggressorSellLots = 0

  ingest(book: DepthBook): void {
    for (const trade of book.trades) {
      if (this.seen.has(trade.id)) continue
      this.seen.add(trade.id)
      this.tradeCount += 1
      if (trade.side === "BUY") this.aggressorBuyLots += trade.lots
      else this.aggressorSellLots += trade.lots
      if (trade.buyer) this.totalsFor(trade.buyer).boughtLots += trade.lots
      if (trade.seller) this.totalsFor(trade.seller).soldLots += trade.lots
    }
  }

  // Called when the subscribed instrument changes; the tape starts over.
  reset(): void {
    this.seen.clear()
    this.brokers.clear()
    this.tradeCount = 0
    this.aggressorBuyLots = 0
    this.aggressorSellLots = 0
  }

  snapshot(): TradeFlowSummary {
    const brokers = [...this.brokers.entries()]
      .map(([brokerage, totals]) => ({
        brokerage,
        boughtLots: totals.boughtLots,
        soldLots: totals.soldLots,
        netLots: totals.boughtLots - totals.soldLots,
      }))
      .sort((left, right) => Math.abs(right.netLots) - Math.abs(left.netLots))
    return {
      tradeCount: this.tradeCount,
      aggressorBuyLots: this.aggressorBuyLots,
      aggressorSellLots: this.aggressorSellLots,
      brokers,
    }
  }

  private totalsFor(brokerage: string): BrokerTotals {
    let totals = this.brokers.get(brokerage)
    if (!totals) {
      totals = { boughtLots: 0, soldLots: 0 }
      this.brokers.set(brokerage, totals)
    }
    return totals
  }
}
