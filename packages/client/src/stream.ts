import type { AlertTriggerEvent, PriceAlertView } from "@trbot/market/alert-monitor.ts"
import type { DepthBookListener, DepthStatusListener, DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteListener, EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import type { ConnectionListener, QuoteStream, QuoteUpdateListener } from "@trbot/market/quote-stream.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { parseServerFrame, STREAM_CHANNELS } from "@trbot/protocol/stream.ts"
import type { ClientFrame, ServerFrame, StopOutcome } from "@trbot/protocol/stream.ts"
import type { AccountLiveUpdateListener, AccountStream } from "@trbot/trading/account.ts"
import type { StopRuleView, StopTriggerEvent } from "@trbot/trading/stop-monitor.ts"

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 3000, 5000]

function webSocketProtocols<T extends NonNullable<object>>(options: T): string[] {
  // SAFETY: Bun accepts its headers/TLS socket options in WebSocket's second argument.
  return options as string[]
}

export interface StreamConnectionOptions {
  url: string
  token: string
  /**
   * Certificate authority to trust, for a server using a self-signed
   * certificate. The socket needs its own copy: it does not go through the HTTP
   * client, so trusting the authority there leaves this one retrying forever.
   */
  ca?: string | null
  /**
   * Called on the first failure of an outage, not on every retry: the reconnect
   * loop never gives up, so reporting each attempt would fill the log with one
   * fact repeated. A reconnect arms it again.
   */
  onError?: (cause: unknown) => void
  reconnectDelaysMs?: number[]
}

/**
 * One socket to the server, shared by every stream contract.
 *
 * Subscriptions are remembered so a reconnect restores them: the server treats a
 * new socket as a new client, so it has to be told again what this one wants.
 */
export class StreamConnection {
  private socket: WebSocket | null = null
  private readonly listeners = new Set<(frame: ServerFrame) => void>()
  private readonly pending: ClientFrame[] = []
  private readonly subscriptions = new Map<string, ClientFrame>()
  private readonly reconnectDelaysMs: number[]
  private attempt = 0
  private closed = false
  private reported = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: StreamConnectionOptions) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  connect(): void {
    if (this.closed || this.socket) return

    const url = this.options.url.replace(/^http/, "ws") + ROUTES.stream
    const tls = this.options.ca ? { tls: { ca: this.options.ca } } : {}
    const socketOptions = {
      headers: { Authorization: `Bearer ${this.options.token}` },
      ...tls,
    }
    const socket = new WebSocket(url, webSocketProtocols(socketOptions))
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.reported = false
      for (const frame of this.subscriptions.values()) this.write(frame)
      for (const frame of this.pending.splice(0)) this.write(frame)
    }
    socket.onmessage = (event) => {
      const frame = parseServerFrame(String(event.data))
      if (frame) this.dispatch(frame)
    }
    socket.onerror = () => {
      if (this.reported) return
      this.reported = true
      this.options.onError?.(new Error("The connection to the trbot server failed"))
    }
    socket.onclose = () => {
      this.socket = null
      // Every channel runs over this one socket, so losing it means none of them
      // is live. Saying so is the point: the panels would otherwise keep their
      // live marker beside a price that stopped updating when the server died.
      // The server sends the real upstream status back on resubscribe.
      for (const channel of STREAM_CHANNELS) {
        this.dispatch({ type: "status", channel, connected: false })
      }
      // Depth reports itself in its own vocabulary rather than as a connected
      // flag, so the generic frame above passes it by. "connecting" is exactly
      // what a socket in its reconnect loop is doing.
      this.dispatch({ type: "depthStatus", status: "connecting" })
      if (!this.closed) this.scheduleReconnect()
    }
  }

  private dispatch(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.listeners.clear()
    this.subscriptions.clear()
  }

  /** Returns a function that removes the listener again. */
  on(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Sends a frame and remembers it, so a reconnect replays the subscription. */
  subscribe(key: string, frame: ClientFrame): void {
    this.subscriptions.set(key, frame)
    // Deliberately not send(): a socket that is not open yet would queue this as
    // pending and then receive it a second time from the replay above.
    this.connect()
    if (this.socket?.readyState === WebSocket.OPEN) this.write(frame)
  }

  unsubscribe(key: string, frame: ClientFrame): void {
    this.subscriptions.delete(key)
    // Also deliberately not send(). A queued unsubscribe would be written after
    // the replay on open, so a channel subscribed again in the meantime would be
    // torn down by it — the client believing it is watching something the server
    // has stopped sending. With the socket down there is nothing to undo anyway:
    // the server treats a new socket as a new client.
    if (this.socket?.readyState === WebSocket.OPEN) this.write(frame)
  }

  send(frame: ClientFrame): void {
    this.connect()
    if (this.socket?.readyState === WebSocket.OPEN) this.write(frame)
    else this.pending.push(frame)
  }

  private write(frame: ClientFrame): void {
    this.socket?.send(JSON.stringify(frame))
  }

  private scheduleReconnect(): void {
    const index = Math.min(this.attempt, this.reconnectDelaysMs.length - 1)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelaysMs[index] ?? 1000)
  }
}

export class WsQuoteStream implements QuoteStream {
  private readonly listeners: QuoteUpdateListener[] = []
  private readonly connectionListeners: ConnectionListener[] = []
  private readonly detach: () => void

  constructor(private readonly connection: StreamConnection) {
    this.detach = connection.on((frame) => {
      if (frame.type === "quotes") for (const listener of this.listeners) listener(frame.update)
      if (frame.type === "status" && frame.channel === "quotes") {
        for (const listener of this.connectionListeners) listener(frame.connected)
      }
    })
  }

  subscribe(listener: QuoteUpdateListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: ConnectionListener): void {
    this.connectionListeners.push(listener)
  }

  start(symbols: string[]): void {
    if (symbols.length === 0) return
    this.connection.subscribe("quotes", { type: "subscribe", channel: "quotes", symbols })
  }

  stop(): void {
    this.connection.unsubscribe("quotes", { type: "unsubscribe", channel: "quotes" })
  }

  destroy(): void {
    this.detach()
  }
}

export class WsEquityQuoteStream implements EquityQuoteStream {
  private readonly listeners: EquityQuoteListener[] = []
  private readonly connectionListeners: ((connected: boolean) => void)[] = []
  private readonly detach: () => void

  constructor(private readonly connection: StreamConnection) {
    this.detach = connection.on((frame) => {
      if (frame.type === "equityQuotes") for (const listener of this.listeners) listener(frame.update)
      if (frame.type === "status" && frame.channel === "equityQuotes") {
        for (const listener of this.connectionListeners) listener(frame.connected)
      }
    })
  }

  subscribe(listener: EquityQuoteListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener)
  }

  start(symbol: string): void {
    this.connection.subscribe("equityQuotes", { type: "subscribe", channel: "equityQuotes", symbol })
  }

  stop(): void {
    this.connection.unsubscribe("equityQuotes", { type: "unsubscribe", channel: "equityQuotes" })
  }

  destroy(): void {
    this.detach()
  }
}

export class WsDepthStream implements DepthStream {
  private readonly listeners: DepthBookListener[] = []
  private readonly statusListeners: DepthStatusListener[] = []
  private readonly detach: () => void

  constructor(private readonly connection: StreamConnection) {
    this.detach = connection.on((frame) => {
      if (frame.type === "depth") for (const listener of this.listeners) listener(frame.book)
      if (frame.type === "depthStatus") for (const listener of this.statusListeners) listener(frame.status)
    })
  }

  subscribe(listener: DepthBookListener): void {
    this.listeners.push(listener)
  }

  onStatusChange(listener: DepthStatusListener): void {
    this.statusListeners.push(listener)
  }

  start(symbol: string): void {
    this.connection.subscribe("depth", { type: "subscribe", channel: "depth", symbol })
  }

  stop(): void {
    this.connection.unsubscribe("depth", { type: "unsubscribe", channel: "depth" })
  }

  destroy(): void {
    this.detach()
  }
}

export class WsAccountStream implements AccountStream {
  private readonly listeners: AccountLiveUpdateListener[] = []
  private readonly connectionListeners: ((connected: boolean) => void)[] = []
  private readonly detach: () => void

  constructor(private readonly connection: StreamConnection) {
    this.detach = connection.on((frame) => {
      if (frame.type === "account") for (const listener of this.listeners) listener(frame.update)
      if (frame.type === "status" && frame.channel === "account") {
        for (const listener of this.connectionListeners) listener(frame.connected)
      }
    })
  }

  subscribe(listener: AccountLiveUpdateListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener)
  }

  /**
   * Remembered rather than merely sent: a reconnect gets a server that knows
   * nothing about this socket, and a fresh session gets an account stream with
   * no orders being followed at all. Either way an order's fills would stop
   * arriving until something else happened to refresh the account.
   */
  setPendingOrders(orderUids: string[]): void {
    this.connection.subscribe("pendingOrders", { type: "pendingOrders", orderUids })
  }

  start(): void {
    this.connection.subscribe("account", { type: "subscribe", channel: "account" })
  }

  stop(): void {
    this.connection.unsubscribe("account", { type: "unsubscribe", channel: "account" })
  }

  destroy(): void {
    this.detach()
  }
}

export interface MonitorEvents {
  onStopTriggered?: (event: StopTriggerEvent, remainingMs: number, held: boolean) => void
  onStopResolved?: (ruleId: string, outcome: StopOutcome) => void
  onStopViews?: (views: StopRuleView[]) => void
  onAlertTriggered?: (event: AlertTriggerEvent) => void
  onAlertViews?: (views: PriceAlertView[]) => void
  onSessionExpired?: () => void
}

/**
 * Bridges the server's monitor frames to the terminal. Stops and alerts run on
 * the server; the client shows what fired and sends back the trader's decision.
 */
export class MonitorClient {
  constructor(
    private readonly connection: StreamConnection,
    events: MonitorEvents,
  ) {
    connection.on((frame) => {
      switch (frame.type) {
        case "stopTriggered":
          events.onStopTriggered?.(frame.event, frame.remainingMs, frame.held)
          return
        case "stopResolved":
          events.onStopResolved?.(frame.ruleId, frame.outcome)
          return
        case "stops":
          events.onStopViews?.(frame.views)
          return
        case "alertTriggered":
          events.onAlertTriggered?.(frame.event)
          return
        case "alerts":
          events.onAlertViews?.(frame.views)
          return
        case "session":
          events.onSessionExpired?.()
          return
        default:
          return
      }
    })
  }

  decideAlert(alertId: string, decision: "dismiss" | "rearm"): void {
    this.connection.send({ type: "alertDecision", alertId, decision })
  }
}
