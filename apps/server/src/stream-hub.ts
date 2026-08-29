import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { ClientFrame, ServerFrame, StreamChannel } from "@trbot/protocol/stream.ts"
import type { PerformanceRecorder } from "@trbot/telemetry/performance.ts"
import type { AccountLiveUpdate } from "@trbot/trading/account.ts"
import type { ProviderSessionAccess, ProviderSources } from "./session.ts"

export interface SocketData {
  /** The client process owning any temporary permission grants. */
  clientId: string | null
  subscriptions: Set<StreamChannel>
  quoteSymbols: string[]
  equitySymbol: string | null
  depthSymbol: string | null
  /** Orders this client is following, so their fills reach it. */
  pendingOrders: string[]
  /** Market-data frames skipped because this socket was not keeping up. */
  dropped: number
}

export function newSocketData(clientId: string | null = null): SocketData {
  return {
    clientId,
    subscriptions: new Set(),
    quoteSymbols: [],
    equitySymbol: null,
    depthSymbol: null,
    pendingOrders: [],
    dropped: 0,
  }
}

export interface StreamSocket {
  data: SocketData
  send(payload: string): number
  getBufferedAmount(): number
}

/**
 * How much unsent data a socket may hold before market data is dropped for it.
 * A slow client must not make the server buffer without limit, and a dropped
 * tick costs nothing: the next one supersedes it.
 */
const BACKPRESSURE_LIMIT_BYTES = 1 << 20
const MARKET_FRAME_INTERVAL_MS = 1_000 / 30

type MarketChannel = Extract<StreamChannel, "quotes" | "equityQuotes" | "depth">
type MarketFrame = Extract<ServerFrame, { type: "quotes" | "equityQuotes" | "depth" }>

interface PendingMarketFrame {
  channel: MarketChannel
  frame: MarketFrame
  symbol: string
  queuedAt: number
}

export interface StreamHubOptions {
  /** Tracks the client process that owns temporary tool grants across brief reconnects. */
  onClientAttach?: (clientId: string | null) => void
  onClientDetach?: (clientId: string | null) => void
  /**
   * Symbols the server needs regardless of who is attached — the ones the stop
   * and alert monitors watch. Without these, closing the last client would stop
   * the prices those monitors depend on.
   */
  extraQuoteSymbols?: () => string[]
  /** Called for every quote, including when no client is subscribed. */
  onQuote?: (update: QuoteUpdate) => void
  /**
   * Called for every account update, including when no client is subscribed.
   *
   * A stop decides whether to fire, and how much to exit, from what it believes
   * is held. Forwarding these to clients is not enough: the server has to hear
   * them too, or a position closed elsewhere stays open as far as a stop knows.
   */
  onAccount?: (update: AccountLiveUpdate) => void
  /**
   * Whether the server wants the account stream for itself, regardless of who is
   * attached — true while any stop rule is armed. Without this the stream stops
   * with the last client, which is exactly when an unattended stop is the only
   * thing protecting the position.
   */
  wantsAccount?: () => boolean
  performance?: PerformanceRecorder
}

/**
 * Fans one set of upstream provider streams out to every connected client.
 *
 * The provider is subscribed once per channel no matter how many clients are
 * attached; quote subscriptions carry the union of what clients asked for plus
 * whatever the monitors need, and an upstream stream stops when nothing wants it.
 */
interface SymbolStream {
  stream: { stop(): void }
  symbol: string
}

export class StreamHub {
  private readonly sockets = new Set<StreamSocket>()
  private attached: ProviderSources | null = null
  private readonly pendingMarketFrames = new Map<string, PendingMarketFrame>()
  private marketFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastMarketFlushAt: number | null = null
  // One upstream connection per watched symbol, since these channels carry a
  // single symbol each. Two clients on different symbols are both served.
  private readonly depthStreams = new Map<string, SymbolStream>()
  private readonly equityStreams = new Map<string, SymbolStream>()
  /**
   * The last status frame sent for each channel, keyed by channel or by
   * `channel:symbol` where the upstream carries one symbol per connection.
   *
   * An upstream stream announces itself only when its connectivity changes, so a
   * client subscribing to one that is already running would hear nothing. It has
   * just marked every channel stale — losing the socket means losing all of them
   * — and would otherwise sit showing nothing as live while data flowed past.
   */
  private readonly lastStatus = new Map<string, ServerFrame>()

  constructor(
    private readonly session: ProviderSessionAccess,
    private readonly options: StreamHubOptions = {},
  ) {
    session.onExpired(() => this.broadcast({ type: "session", state: "expired" }))
    // A new session hands out new streams and stops the old ones, so everything
    // has to be taken out again. Attached clients stay attached throughout and
    // would otherwise sit on a socket that has simply gone silent.
    session.onSession(() => this.refresh())
  }

  /**
   * Re-evaluates every upstream subscription: after the monitors change symbols,
   * and after a sign-in or recovery replaces the session's streams.
   */
  refresh(): void {
    this.attachUpstream()
    this.resyncQuotes()
    this.resyncSymbols("equityQuotes")
    this.resyncSymbols("depth")
    // The first armed rule is what makes the server want the account stream.
    this.resyncAccount()
    this.resyncPendingOrders()
  }

  add(socket: StreamSocket): void {
    this.sockets.add(socket)
    this.options.onClientAttach?.(socket.data.clientId)
    this.attachUpstream()
  }

  remove(socket: StreamSocket): void {
    this.sockets.delete(socket)
    this.options.onClientDetach?.(socket.data.clientId)
    this.resyncQuotes()
    this.resyncSymbols("equityQuotes")
    this.resyncSymbols("depth")
    this.resyncAccount()
    this.resyncPendingOrders()
    if (this.sockets.size === 0) this.resetMarketFrames()
  }

  handle(socket: StreamSocket, frame: ClientFrame): void {
    switch (frame.type) {
      case "subscribe":
        socket.data.subscriptions.add(frame.channel)
        if (frame.channel === "quotes") socket.data.quoteSymbols = frame.symbols
        if (frame.channel === "equityQuotes") socket.data.equitySymbol = frame.symbol
        if (frame.channel === "depth") socket.data.depthSymbol = frame.symbol
        this.resync(frame.channel)
        this.sendStatus(socket, frame.channel)
        return
      case "unsubscribe":
        socket.data.subscriptions.delete(frame.channel)
        if (frame.channel === "quotes") socket.data.quoteSymbols = []
        if (frame.channel === "equityQuotes") socket.data.equitySymbol = null
        if (frame.channel === "depth") socket.data.depthSymbol = null
        this.resync(frame.channel)
        return
      case "pendingOrders":
        socket.data.pendingOrders = frame.orderUids
        this.resyncPendingOrders()
        return
      default:
        return
    }
  }

  /**
   * Sends to every client. Used for frames a trader must not miss — a fired stop,
   * a resolved one, an expired session — so these are never dropped.
   */
  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame)
    for (const socket of this.sockets) this.send(socket, frame, payload)
  }

  /**
   * Sends market data to the sockets that asked for it, skipping any that has
   * fallen behind. `symbol` restricts a frame to the clients watching it, which
   * is what lets two clients hold different depth or equity subscriptions
   * without seeing each other's.
   */
  private emit(channel: StreamChannel, frame: ServerFrame, symbol?: string): void {
    const payload = JSON.stringify(frame)
    for (const socket of this.sockets) {
      if (!socket.data.subscriptions.has(channel)) continue
      if (symbol !== undefined && !this.wants(socket, channel, symbol)) continue
      if (socket.getBufferedAmount() > BACKPRESSURE_LIMIT_BYTES) {
        socket.data.dropped += 1
        this.options.performance?.count(`ws.backpressure_dropped.${channel}`)
        continue
      }
      this.send(socket, frame, payload)
    }
  }

  /**
   * Keeps only the newest complete snapshot for each channel and symbol while a
   * frame window is open. Monitor callbacks run before this queue, so sampling
   * client traffic never costs the server a tick used for trading decisions.
   */
  private emitMarket(channel: MarketChannel, frame: MarketFrame, symbol: string): void {
    const now = performance.now()
    this.options.performance?.count(`market.upstream.${channel}`)
    if (!this.hasSubscriber(channel, symbol)) return

    const elapsed = this.lastMarketFlushAt === null
      ? MARKET_FRAME_INTERVAL_MS
      : now - this.lastMarketFlushAt
    if (elapsed >= MARKET_FRAME_INTERVAL_MS && this.marketFlushTimer === null) {
      this.lastMarketFlushAt = now
      this.options.performance?.observe(`market.queue_ms.${channel}`, 0)
      this.emit(channel, frame, symbol)
      return
    }

    const key = `${channel}:${symbol}`
    if (this.pendingMarketFrames.has(key)) this.options.performance?.count(`market.coalesced.${channel}`)
    this.pendingMarketFrames.set(key, { channel, frame, symbol, queuedAt: now })
    if (this.marketFlushTimer !== null) return

    const delay = Math.max(0, MARKET_FRAME_INTERVAL_MS - elapsed)
    this.marketFlushTimer = setTimeout(() => this.flushMarketFrames(), delay)
  }

  private flushMarketFrames(): void {
    this.marketFlushTimer = null
    if (this.pendingMarketFrames.size === 0) return

    const frames = [...this.pendingMarketFrames.values()]
    this.pendingMarketFrames.clear()
    const now = performance.now()
    this.lastMarketFlushAt = now
    for (const { channel, frame, symbol, queuedAt } of frames) {
      this.options.performance?.observe(`market.queue_ms.${channel}`, now - queuedAt)
      this.emit(channel, frame, symbol)
    }
  }

  private resetMarketFrames(): void {
    if (this.marketFlushTimer !== null) clearTimeout(this.marketFlushTimer)
    this.marketFlushTimer = null
    this.pendingMarketFrames.clear()
    this.lastMarketFlushAt = null
  }

  private hasSubscriber(channel: MarketChannel, symbol: string): boolean {
    for (const socket of this.sockets) {
      if (socket.data.subscriptions.has(channel) && this.wants(socket, channel, symbol)) return true
    }
    return false
  }

  private send(socket: StreamSocket, frame: ServerFrame, payload: string): void {
    const bytes = socket.send(payload)
    const telemetry = this.options.performance
    if (!telemetry) return
    if (bytes === 0) {
      telemetry.count("ws.send_dropped")
      return
    }
    if (bytes < 0) {
      telemetry.count("ws.send_backpressure")
      return
    }
    telemetry.count("ws.sent.frames")
    telemetry.count(`ws.sent.${frame.type}`)
    telemetry.count("ws.sent.bytes", bytes)
  }

  /** Remembers a status frame and sends it on, so a later subscriber can be told. */
  private status(key: string, channel: StreamChannel, frame: ServerFrame, symbol?: string): void {
    this.lastStatus.set(key, frame)
    this.emit(channel, frame, symbol)
  }

  /** Tells one socket where a channel stands right now. */
  private sendStatus(socket: StreamSocket, channel: StreamChannel): void {
    const symbol = channel === "depth" ? socket.data.depthSymbol : socket.data.equitySymbol
    const key = channel === "depth" || channel === "equityQuotes" ? `${channel}:${symbol ?? ""}` : channel
    const frame = this.lastStatus.get(key)
    if (frame) this.send(socket, frame, JSON.stringify(frame))
  }

  private wants(socket: StreamSocket, channel: StreamChannel, symbol: string): boolean {
    if (channel === "depth") return socket.data.depthSymbol === symbol
    if (channel === "equityQuotes") return socket.data.equitySymbol === symbol
    if (channel === "quotes") return socket.data.quoteSymbols.includes(symbol)
    return true
  }

  private sources(): ProviderSources | null {
    return this.session.authenticated ? this.session.require() : null
  }

  /**
   * Subscribes to the provider once per session. Listeners are registered on the
   * source objects, which live as long as the session, so this runs at most once
   * per sign-in.
   */
  private attachUpstream(): void {
    const sources = this.sources()
    if (!sources || this.attached === sources) return
    // A re-login replaces every stream the old session handed out, so what any
    // of them last reported says nothing about the ones taking their place.
    this.depthStreams.clear()
    this.equityStreams.clear()
    this.lastStatus.clear()
    this.resetMarketFrames()
    this.attached = sources

    sources.quotes.subscribe((update) => {
      this.options.onQuote?.(update)
      this.emitMarket("quotes", { type: "quotes", update }, update.symbol)
    })
    sources.quotes.onConnectionChange((connected) =>
      this.status("quotes", "quotes", { type: "status", channel: "quotes", connected }),
    )
    sources.accountStream.subscribe((update) => {
      this.emit("account", { type: "account", update })
      this.options.onAccount?.(update)
    })
    sources.accountStream.onConnectionChange((connected) =>
      this.status("account", "account", { type: "status", channel: "account", connected }),
    )
  }

  private resync(channel: StreamChannel): void {
    this.attachUpstream()
    if (channel === "quotes") return this.resyncQuotes()
    if (channel === "account") return this.resyncAccount()
    this.resyncSymbols(channel)
  }

  /** The provider takes a symbol list, so it gets the union of what clients want. */
  private resyncQuotes(): void {
    const sources = this.sources()
    if (!sources) return

    const union = new Set<string>(this.options.extraQuoteSymbols?.() ?? [])
    for (const socket of this.sockets) {
      if (socket.data.subscriptions.has("quotes")) for (const symbol of socket.data.quoteSymbols) union.add(symbol)
    }

    if (union.size === 0) sources.quotes.stop()
    else sources.quotes.start([...union])
  }

  /**
   * Opens an upstream stream for every symbol some client wants on `channel`,
   * and stops the ones nobody wants any more. Each stream's frames are routed
   * back to the sockets watching that symbol.
   */
  private resyncSymbols(channel: "equityQuotes" | "depth"): void {
    const sources = this.sources()
    if (!sources) return

    const active = channel === "depth" ? this.depthStreams : this.equityStreams
    const wanted = new Set<string>()
    for (const socket of this.sockets) {
      if (!socket.data.subscriptions.has(channel)) continue
      const symbol = channel === "depth" ? socket.data.depthSymbol : socket.data.equitySymbol
      if (symbol) wanted.add(symbol)
    }

    for (const [symbol, entry] of active) {
      if (wanted.has(symbol)) continue
      entry.stream.stop()
      active.delete(symbol)
    }

    for (const symbol of wanted) {
      if (active.has(symbol)) continue
      active.set(symbol, channel === "depth" ? this.openDepth(sources, symbol) : this.openEquity(sources, symbol))
    }
  }

  private openDepth(sources: ProviderSources, symbol: string): SymbolStream {
    const stream = sources.openDepthStream()
    stream.subscribe((book) => this.emitMarket("depth", { type: "depth", book }, book.symbol))
    // Status frames carry no symbol, so they are routed by the stream that
    // reported them rather than by the frame's contents.
    stream.onStatusChange((status) => this.status(`depth:${symbol}`, "depth", { type: "depthStatus", status }, symbol))
    stream.start(symbol)
    return { stream, symbol }
  }

  private openEquity(sources: ProviderSources, symbol: string): SymbolStream {
    const stream = sources.openEquityQuoteStream()
    stream.subscribe((update) => this.emitMarket("equityQuotes", { type: "equityQuotes", update }, update.symbol))
    stream.onConnectionChange((connected) =>
      this.status(`equityQuotes:${symbol}`, "equityQuotes", { type: "status", channel: "equityQuotes", connected }, symbol),
    )
    stream.start(symbol)
    return { stream, symbol }
  }

  private resyncAccount(): void {
    const sources = this.sources()
    if (!sources) return

    const wanted = this.options.wantsAccount?.()
      || [...this.sockets].some((socket) => socket.data.subscriptions.has("account"))
    if (wanted) sources.accountStream.start()
    else sources.accountStream.stop()
  }

  /**
   * The orders being followed, as the union of what every client asked for.
   *
   * Each pending order opens its own upstream stream, so this is held per socket
   * rather than written straight through: one terminal would otherwise replace
   * what another is following, and a new session would start following nothing
   * at all — an order's fills going unseen until something refreshed the account.
   */
  private resyncPendingOrders(): void {
    const sources = this.sources()
    if (!sources) return

    const union = new Set<string>()
    for (const socket of this.sockets) for (const uid of socket.data.pendingOrders) union.add(uid)
    sources.accountStream.setPendingOrders([...union])
  }
}
