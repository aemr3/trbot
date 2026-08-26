import { parseTopic } from "./fields.ts"
import { CONTROL_FRAME_TYPES, parseFrame } from "./frames.ts"
import type { FeedSession } from "./session.ts"
import { asRecord, asText, type FeedRecord, type FeedSnapshotRow, type FeedValue } from "./value.ts"

export const REALTIME_SOCKET_URL = "wss://markets.fintables.com/vessel"

/** Topics per frame. The feed's own client batches at this size. */
const TOPIC_BATCH_SIZE = 200
const HEARTBEAT_INTERVAL_MS = 4_000
/** Silence longer than this means the connection is dead even if the socket is open. */
const MESSAGE_TIMEOUT_MS = 8_000
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 3_000, 5_000, 10_000]

export interface SocketHandlers {
  onOpen(): void
  onMessage(data: string): void
  onClose(): void
  onError(cause: unknown): void
}

export interface SocketHandle {
  send(data: string): void
  close(): void
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle

/** A field value changed on one symbol. */
export interface FieldUpdate {
  symbol: string
  field: string
  value: FeedValue
}

/** A depth level update, carrying the feed's own level payload. */
export interface DepthUpdate {
  symbol: string
  payload: FeedRecord
}

/** A printed trade. */
export interface TradeUpdate {
  symbol: string
  payload: FeedRecord
}

export interface SocketListener {
  onFields?(updates: FieldUpdate[]): void
  onDepth?(update: DepthUpdate): void
  onTrade?(update: TradeUpdate): void
  onConnectionChange?(connected: boolean): void
  /**
   * The license moved to another device. Reconnecting would only take it back
   * and start a fight, so the socket stops and reports instead.
   */
  onLicenseTaken?(): void
}

export interface SocketSubscriptionOptions {
  /** Sends a subscribe frame even when another consumer already retains the topic. */
  refresh?: boolean
}

/**
 * The subscription surface a data consumer needs.
 *
 * Quotes and depth take this rather than the whole socket: they have no business
 * starting, stopping, or reconnecting the shared connection.
 */
export interface SocketSubscriber {
  subscribe(
    topics: string[],
    listener: SocketListener,
    options?: SocketSubscriptionOptions,
  ): () => void
}

export interface MarketSocketOptions {
  url?: string
  socketFactory?: SocketFactory
  reconnectDelaysMs?: number[]
  onError?: (cause: unknown) => void
}

interface Subscription {
  topics: Set<string>
  listener: SocketListener
}

/** A snapshot entry as a plain value, or undefined when it is a nested object. */
function asValue(entry: FeedValue | FeedRecord | undefined): FeedValue | undefined {
  if (entry === undefined) return undefined
  // SAFETY: the row schema admits only a feed value or a nested record, and
  // `asRecord` returning null has ruled the record out.
  return asRecord(entry) === null ? (entry as FeedValue) : undefined
}

function defaultSocketFactory(url: string, handlers: SocketHandlers): SocketHandle {
  const socket = new WebSocket(url)
  socket.addEventListener("open", () => handlers.onOpen())
  socket.addEventListener("message", (event: MessageEvent) => handlers.onMessage(String(event.data)))
  socket.addEventListener("close", () => handlers.onClose())
  socket.addEventListener("error", (event) => handlers.onError(event))
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}

/**
 * The single realtime connection to the feed.
 *
 * There is exactly one of these per process, and that is a licensing constraint
 * rather than an optimization: the exchange permits one concurrent session per
 * licence, and a second connection evicts the first. Every consumer — quotes,
 * depth, instrument rows — multiplexes onto this socket, and topics are
 * reference counted so one consumer unsubscribing does not blind another that
 * still wants the same field.
 */
export class MarketSocket implements SocketSubscriber {
  private readonly subscriptions = new Set<Subscription>()
  private readonly topicCounts = new Map<string, number>()
  private readonly reconnectDelaysMs: number[]
  private readonly url: string
  private readonly socketFactory: SocketFactory

  private socket: SocketHandle | null = null
  private running = false
  private loggedIn = false
  private connected = false
  private licenseTaken = false
  private attempt = 0
  private generation = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly session: Pick<FeedSession, "streamToken" | "renewStreamToken">,
    private readonly options: MarketSocketOptions = {},
  ) {
    this.url = options.url ?? REALTIME_SOCKET_URL
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  get isConnected(): boolean {
    return this.connected
  }

  /**
   * Registers `listener` for `topics`, opening the connection if needed.
   * Returns a function that releases those topics.
   */
  subscribe(
    topics: string[],
    listener: SocketListener,
    options: SocketSubscriptionOptions = {},
  ): () => void {
    const subscription: Subscription = { topics: new Set(topics), listener }
    this.subscriptions.add(subscription)

    const added = this.retain(subscription.topics)
    if (!this.running) this.start()
    else if (this.loggedIn) {
      const requested = options.refresh ? [...subscription.topics] : added
      if (requested.length > 0) this.send({ type: "subscribe", topics: requested })
    }
    if (this.connected) listener.onConnectionChange?.(true)

    return () => this.release(subscription)
  }

  stop(): void {
    this.running = false
    this.generation += 1
    this.clearTimers()
    this.closeSocket()
    this.notifyConnection(false)
  }

  /**
   * Drops the connection and dials again with a fresh licence, keeping every
   * subscription. Used when the licence rotates: the open socket is bound to the
   * old token, but the consumers still want their topics.
   */
  redial(): void {
    if (this.subscriptions.size === 0) return
    this.licenseTaken = false
    this.running = true
    this.attempt = 0
    this.clearTimers()
    this.closeSocket()
    this.notifyConnection(false)
    void this.connect(++this.generation)
  }

  private release(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return
    const dropped: string[] = []
    for (const item of subscription.topics) {
      const count = (this.topicCounts.get(item) ?? 1) - 1
      if (count <= 0) {
        this.topicCounts.delete(item)
        dropped.push(item)
      } else {
        this.topicCounts.set(item, count)
      }
    }
    if (this.loggedIn && dropped.length > 0) this.send({ type: "unsubscribe", topics: dropped })
    if (this.subscriptions.size === 0) this.stop()
  }

  /** Counts new interest in `topics` and returns the ones nobody held yet. */
  private retain(topics: Iterable<string>): string[] {
    const added: string[] = []
    for (const item of topics) {
      const count = this.topicCounts.get(item) ?? 0
      if (count === 0) added.push(item)
      this.topicCounts.set(item, count + 1)
    }
    return added
  }

  private start(): void {
    if (this.running) return
    this.running = true
    this.licenseTaken = false
    this.attempt = 0
    void this.connect(++this.generation)
  }

  private async connect(generation: number): Promise<void> {
    let streamToken: string
    try {
      streamToken = await this.session.streamToken()
    } catch (error) {
      this.options.onError?.(error)
      this.scheduleReconnect(generation)
      return
    }
    if (!this.running || generation !== this.generation) return

    this.loggedIn = false
    try {
      const socket = this.socketFactory(`${this.url}?streamtoken=${encodeURIComponent(streamToken)}`, {
        onOpen: () => {
          if (generation !== this.generation) return
          // The token goes in the query string to get the socket accepted and
          // again here to bind the session to the licence.
          this.send({ type: "login", token: streamToken })
          this.startHeartbeat()
          this.armWatchdog(generation)
        },
        onMessage: (data) => this.handleMessage(data, generation),
        onClose: () => {
          if (generation !== this.generation) return
          this.notifyConnection(false)
          this.clearTimers()
          this.scheduleReconnect(generation)
        },
        onError: (cause) => {
          if (generation !== this.generation) return
          this.options.onError?.(cause)
        },
      })
      this.socket = socket
    } catch (error) {
      this.options.onError?.(error)
      this.scheduleReconnect(generation)
    }
  }

  private handleMessage(data: string, generation: number): void {
    if (generation !== this.generation) return
    this.armWatchdog(generation)

    const parsed = parseFrame(data)
    if (!parsed) return

    if (parsed.kind === "control") {
      switch (parsed.frame.type) {
        case CONTROL_FRAME_TYPES.connectionAccepted:
          return
        case CONTROL_FRAME_TYPES.loginAccepted:
          this.loggedIn = true
          this.attempt = 0
          this.sendAllTopics()
          return
        case CONTROL_FRAME_TYPES.subscribed:
          this.notifyConnection(true)
          this.emitSnapshot(parsed.frame.data ?? [])
          return
        case CONTROL_FRAME_TYPES.sessionTaken:
          this.handleLicenseTaken()
          return
        default:
          return
      }
    }

    if (parsed.kind === "field") {
      const topic = parseTopic(parsed.frame.k)
      if (!topic) return
      this.notifyConnection(true)
      this.dispatchFields(topic.symbol, [{ symbol: topic.symbol, field: topic.field, value: parsed.frame.v }])
      return
    }

    if (parsed.kind === "depth") {
      const symbol = parsed.frame.ob
      this.notifyConnection(true)
      for (const subscription of this.subscriptions) {
        if (!this.holdsSymbol(subscription, symbol)) continue
        subscription.listener.onDepth?.({ symbol, payload: parsed.frame.v })
      }
      return
    }

    const symbol = parsed.frame.o
    this.notifyConnection(true)
    for (const subscription of this.subscriptions) {
      if (!this.holdsSymbol(subscription, symbol)) continue
      subscription.listener.onTrade?.({ symbol, payload: parsed.frame.v })
    }
  }

  /**
   * The acknowledgement carries the opening state per symbol.
   *
   * Most entries are plain fields, but the order book comes nested — an
   * `ob/<side>/<level>` key per level — and those are the opening book, so they
   * are routed to the depth listeners rather than passed off as fields.
   */
  private emitSnapshot(rows: FeedSnapshotRow[]): void {
    for (const row of rows) {
      const symbol = asText(asValue(row.code))
      if (!symbol) continue
      const updates: FieldUpdate[] = []
      for (const [field, entry] of Object.entries(row)) {
        if (field === "code") continue
        const level = field.startsWith("ob/") ? asRecord(entry) : null
        if (level) {
          for (const subscription of this.subscriptions) {
            if (!this.holdsSymbol(subscription, symbol)) continue
            subscription.listener.onDepth?.({ symbol, payload: level })
          }
          continue
        }
        const value = asValue(entry)
        if (value !== undefined) updates.push({ symbol, field, value })
      }
      if (updates.length > 0) this.dispatchFields(symbol, updates)
    }
  }

  private dispatchFields(symbol: string, updates: FieldUpdate[]): void {
    for (const subscription of this.subscriptions) {
      if (!this.holdsSymbol(subscription, symbol)) continue
      subscription.listener.onFields?.(updates)
    }
  }

  private holdsSymbol(subscription: Subscription, symbol: string): boolean {
    for (const item of subscription.topics) {
      if (item.startsWith(`${symbol}/`)) return true
    }
    return false
  }

  /**
   * A licence can only be live on one device, so losing it is terminal for this
   * connection: reconnecting would evict whoever now holds it, and they would
   * evict us straight back.
   */
  private handleLicenseTaken(): void {
    this.licenseTaken = true
    this.running = false
    this.generation += 1
    this.clearTimers()
    this.closeSocket()
    this.notifyConnection(false)
    for (const subscription of this.subscriptions) subscription.listener.onLicenseTaken?.()
  }

  private sendAllTopics(): void {
    const topics = [...this.topicCounts.keys()]
    if (topics.length > 0) this.send({ type: "subscribe", topics })
  }

  private send(message: { type: string; topics?: string[]; token?: string }): void {
    const socket = this.socket
    if (!socket) return
    try {
      if (!message.topics) {
        socket.send(JSON.stringify(message))
        return
      }
      for (let index = 0; index < message.topics.length; index += TOPIC_BATCH_SIZE) {
        socket.send(JSON.stringify({ ...message, topics: message.topics.slice(index, index + TOPIC_BATCH_SIZE) }))
      }
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      try {
        this.socket?.send("ping")
      } catch (error) {
        this.options.onError?.(error)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** An open socket that has gone quiet is still a dead one; treat it as a drop. */
  private armWatchdog(generation: number): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      if (generation !== this.generation || !this.running) return
      this.notifyConnection(false)
      this.closeSocket()
      this.scheduleReconnect(generation)
    }, MESSAGE_TIMEOUT_MS)
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || this.licenseTaken || generation !== this.generation) return
    if (this.reconnectTimer) return
    const index = Math.min(this.attempt, this.reconnectDelaysMs.length - 1)
    this.attempt++
    const delay = this.reconnectDelaysMs[index] ?? 1_000
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running || generation !== this.generation) return
      void this.connect(generation)
    }, delay)
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.loggedIn = false
    if (!socket) return
    try {
      socket.close()
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const subscription of this.subscriptions) subscription.listener.onConnectionChange?.(connected)
  }
}
