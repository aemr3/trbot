import type {
  DepthBook,
  DepthBookListener,
  DepthLevel,
  DepthStatus,
  DepthStatusListener,
  DepthStream,
  DepthTrade,
} from "@trbot/market/depth.ts"
import { DEPTH_FIELDS, FEED_FIELDS, topic } from "./fields.ts"
import { isMarketOpen } from "./session-hours.ts"
import type { DepthUpdate, FieldUpdate, SocketSubscriber, TradeUpdate } from "./socket.ts"
import { parseTradePrint, toTrade } from "./trades.ts"
import { asNumber, pickNumber, pickText, type FeedRecord } from "./value.ts"

const MAX_TRADES = 50

/**
 * The order book for one symbol, assembled from the shared realtime socket.
 *
 * The feed sends the book a level at a time, as
 * `{"ob": symbol, "v": {"l": 0, "obs": "B", "p": 16821, "c": 1, "s": 5}}` —
 * level index, side, price, order count, and size in lots. The opening book
 * arrives nested in the subscription acknowledgement instead, one entry per
 * level; the socket routes both here.
 *
 * Levels are accumulated per side and index, and the whole book is republished
 * on each change. A frame that yields no price reports `unavailable` rather than
 * publishing a book with an invented level.
 */
export interface FeedDepthStreamOptions {
  onLicenseTaken?: () => void
  /**
   * Reads the symbol's trading hours, used to say whether an empty book means a
   * closed market. Without it an empty book is reported as simply empty.
   */
  loadSession?: (symbol: string) => Promise<string | null>
  /** Reads the prints already on the tape, which the socket then appends to. */
  loadTrades?: (symbol: string) => Promise<DepthTrade[]>
  /** Brokerage short names by code, for rendering a print's counterparties. */
  brokerageNames?: () => Promise<Map<string, string>>
  now?: () => number
}

interface LevelKey {
  side: "bid" | "ask"
  index: number
}

/** `obs` names the side: `B` for the bid, `S` for the ask. */
function readSide(payload: FeedRecord): "bid" | "ask" | null {
  // Only `obs` is consulted: `s` on this payload is the size, not the side.
  const raw = pickText(payload, ["obs", "side"])
  if (raw === null) return null
  const value = raw.toLowerCase()
  if (value.startsWith("b")) return "bid"
  if (value.startsWith("a") || value.startsWith("s")) return "ask"
  return null
}

function readLevelKey(payload: FeedRecord): LevelKey | null {
  const side = readSide(payload)
  const index = pickNumber(payload, ["l", "level", "index"])
  if (!side || index === null) return null
  return { side, index }
}

export class FeedDepthStream implements DepthStream {
  private readonly listeners: DepthBookListener[] = []
  private readonly statusListeners: DepthStatusListener[] = []
  private readonly bids = new Map<number, DepthLevel>()
  private readonly asks = new Map<number, DepthLevel>()
  private trades: DepthTrade[] = []
  private buyLots: number | null = null
  private sellLots: number | null = null
  private status: DepthStatus = "idle"
  private symbol: string | null = null
  private session: string | null = null
  private brokerages = new Map<string, string>()
  private release: (() => void) | null = null

  constructor(
    private readonly socket: SocketSubscriber,
    private readonly options: FeedDepthStreamOptions = {},
  ) {}

  subscribe(listener: DepthBookListener): void {
    this.listeners.push(listener)
  }

  onStatusChange(listener: DepthStatusListener): void {
    this.statusListeners.push(listener)
    listener(this.status)
  }

  start(symbol: string): void {
    if (this.symbol === symbol && this.release) return
    this.stop()
    this.symbol = symbol
    this.session = null
    this.setStatus("connecting")
    // Trading hours decide whether an empty book reads as closed or as thin.
    // The read is not on the critical path, so the book publishes without it and
    // republishes once it lands.
    void this.options.loadSession?.(symbol)
      .then((session) => {
        if (this.symbol !== symbol) return
        this.session = session
        this.publish()
      })
      .catch(() => {})
    // The socket only carries new prints, so the tape starts from the ones that
    // already happened.
    void this.options.loadTrades?.(symbol)
      .then((trades) => {
        if (this.symbol !== symbol) return
        // Prints can arrive on the socket while this read is in flight, and they
        // are the newest ones on the tape. Merging keeps them: replacing the list
        // outright would drop every print of the first second or two.
        this.trades = mergeTrades(this.trades, trades)
        this.publish()
      })
      .catch(() => {})
    void this.options.brokerageNames?.()
      .then((names) => {
        this.brokerages = names
      })
      .catch(() => {})
    this.release = this.socket.subscribe(
      DEPTH_FIELDS.map((field) => topic(symbol, field)),
      {
        onDepth: (update) => this.applyDepth(update),
        onTrade: (update) => this.applyTrade(update),
        onFields: (updates) => this.applyFields(updates),
        onConnectionChange: (connected) => {
          if (!connected && this.status === "live") this.setStatus("connecting")
        },
        onLicenseTaken: () => {
          this.setStatus("unavailable")
          this.options.onLicenseTaken?.()
        },
      },
    )
  }

  stop(): void {
    this.release?.()
    this.release = null
    this.symbol = null
    this.session = null
    this.bids.clear()
    this.asks.clear()
    this.trades = []
    this.buyLots = null
    this.sellLots = null
    this.setStatus("idle")
  }

  private applyDepth(update: DepthUpdate): void {
    if (update.symbol !== this.symbol) return
    const key = readLevelKey(update.payload)
    // Without a side and level index there is nothing to place, so the frame is
    // not a book update at all.
    if (!key) return

    const side = key.side === "bid" ? this.bids : this.asks
    const price = pickNumber(update.payload, ["p", "price"])
    const lots = pickNumber(update.payload, ["s", "q", "lots", "quantity"]) ?? 0
    const orderCount = pickNumber(update.payload, ["c", "count", "orders"]) ?? 0

    // A null price is the exchange clearing that level, which is exactly what a
    // whole book looks like outside session hours. It means the level is empty,
    // never that the symbol has no book.
    if (price === null || (lots <= 0 && orderCount <= 0)) side.delete(key.index)
    else side.set(key.index, { price, lots, orderCount })

    // Frames are arriving, so the book is being tracked even while it is empty.
    this.setStatus("live")
    this.publish()
  }

  private applyTrade(update: TradeUpdate): void {
    if (update.symbol !== this.symbol) return
    // Anything that is not a print is dropped rather than guessed at.
    const print = parseTradePrint(update.payload)
    if (!print) return

    const trade = toTrade(print, this.brokerages)
    // The same print can arrive twice across a reconnect, and the feed gives it
    // an id, so the tape is deduplicated on the way in.
    if (this.trades.some((existing) => existing.id === trade.id)) return
    this.trades = [trade, ...this.trades].slice(0, MAX_TRADES)
    this.setStatus("live")
    this.publish()
  }

  /** The side totals behind the buy/sell ratio arrive as ordinary fields. */
  private applyFields(updates: FieldUpdate[]): void {
    let changed = false
    for (const update of updates) {
      if (update.symbol !== this.symbol) continue
      const value = asNumber(update.value)
      if (update.field === FEED_FIELDS.BID_TOTAL_VOLUME) {
        this.buyLots = value
        changed = true
      } else if (update.field === FEED_FIELDS.ASK_TOTAL_VOLUME) {
        this.sellLots = value
        changed = true
      }
    }
    if (changed) this.publish()
  }

  private publish(): void {
    const symbol = this.symbol
    if (!symbol) return
    const now = this.options.now?.() ?? Date.now()
    const book: DepthBook = {
      symbol,
      bids: sortLevels(this.bids, "bid"),
      asks: sortLevels(this.asks, "ask"),
      buyLots: this.buyLots,
      sellLots: this.sellLots,
      trades: this.trades,
      // An empty book inside session hours is a thin market; outside them it is
      // a closed one, and the difference is what the panel needs to say.
      marketClosed: !isMarketOpen(this.session, now),
    }
    for (const listener of this.listeners) listener(book)
  }

  private setStatus(status: DepthStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }
}

/** Best price first on both sides, so index 0 straddles the spread. */
function sortLevels(levels: Map<number, DepthLevel>, side: "bid" | "ask"): DepthLevel[] {
  const sorted = [...levels.entries()].sort(([left], [right]) => left - right).map(([, level]) => level)
  return sorted.sort((left, right) => (side === "bid" ? right.price - left.price : left.price - right.price))
}

/**
 * The tape as one list: prints already held first, then the read that seeded it.
 *
 * Both sides are newest first, and the socket's are newer than anything HTTP
 * returned, so held prints keep the front. A print that appears in both — the
 * usual case for the newest few — is kept once, by id.
 */
function mergeTrades(held: DepthTrade[], loaded: DepthTrade[]): DepthTrade[] {
  const merged: DepthTrade[] = []
  const seen = new Set<string>()
  for (const trade of [...held, ...loaded]) {
    if (seen.has(trade.id)) continue
    seen.add(trade.id)
    merged.push(trade)
  }
  return merged.slice(0, MAX_TRADES)
}
