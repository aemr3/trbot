import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import type { AuthSession } from "@trbot/auth/session.ts"
import type { AuthState } from "@trbot/auth/state.ts"
import type { DepthBook, DepthBookListener, DepthStatusListener, DepthStream } from "@trbot/market/depth.ts"
import type { EquityQuoteStream } from "@trbot/market/equity-quote-stream.ts"
import type { ConnectionListener, QuoteStream, QuoteUpdate, QuoteUpdateListener } from "@trbot/market/quote-stream.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import type { AccountLiveUpdate, AccountStream } from "@trbot/trading/account.ts"
import { ProviderSession, type ProviderSources } from "./session.ts"
import { newSocketData, StreamHub, type SocketData } from "./stream-hub.ts"

class FakeQuoteStream implements QuoteStream {
  listener: QuoteUpdateListener | null = null
  started: string[][] = []
  stopped = 0

  subscribe(listener: QuoteUpdateListener): void {
    this.listener = listener
  }
  connectionListener: ConnectionListener | null = null
  onConnectionChange(listener: ConnectionListener): void {
    this.connectionListener = listener
  }
  start(symbols: string[]): void {
    this.started.push([...symbols].sort())
  }
  stop(): void {
    this.stopped += 1
  }
}

class FakeDepthStream implements DepthStream {
  listener: DepthBookListener | null = null
  statusListener: DepthStatusListener | null = null
  startedWith: string | null = null
  stopped = 0

  subscribe(listener: DepthBookListener): void {
    this.listener = listener
  }
  onStatusChange(listener: DepthStatusListener): void {
    this.statusListener = listener
  }
  start(symbol: string): void {
    this.startedWith = symbol
  }
  stop(): void {
    this.stopped += 1
  }
}

/** Hands out a fresh depth stream per symbol, as the real session does. */
class FakeDepthFactory {
  readonly opened: FakeDepthStream[] = []

  open(): FakeDepthStream {
    const stream = new FakeDepthStream()
    this.opened.push(stream)
    return stream
  }

  forSymbol(symbol: string): FakeDepthStream | undefined {
    return this.opened.find((stream) => stream.startedWith === symbol)
  }
}

const idleStream = {
  subscribe() {},
  onConnectionChange() {},
  start() {},
  stop() {},
  setPendingOrders() {},
}

function sourcesWith(quotes: FakeQuoteStream, depth: FakeDepthFactory): ProviderSources {
  return {
    quotes,
    accountStream: idleStream as unknown as AccountStream,
    openDepthStream: () => depth.open(),
    openEquityQuoteStream: () => idleStream as unknown as EquityQuoteStream,
  } as unknown as ProviderSources
}

/** A session already holding the given sources, without touching a provider. */
function sessionWith(sources: ProviderSources): ProviderSession {
  const store = {
    async get(): Promise<AuthState | null> {
      return null
    },
    async latest(): Promise<AuthState | null> {
      return null
    },
    async put(): Promise<void> {},
  }
  const session = new ProviderSession({
    openAuthSession: async (): Promise<AuthSession> => ({ store, close() {} }),
    credentials: null,
  })
  ;(session as unknown as { current: ProviderSources }).current = sources
  return session
}

interface FakeSocket {
  sent: ServerFrame[]
  buffered: number
  data: SocketData
}

function socket(buffered = 0): FakeSocket & ServerWebSocket<SocketData> {
  const fake: FakeSocket = { sent: [], buffered, data: newSocketData() }
  return {
    ...fake,
    send(payload: string) {
      fake.sent.push(JSON.parse(payload) as ServerFrame)
      return payload.length
    },
    getBufferedAmount() {
      return fake.buffered
    },
    get sent() {
      return fake.sent
    },
    get data() {
      return fake.data
    },
    set buffered(value: number) {
      fake.buffered = value
    },
  } as unknown as FakeSocket & ServerWebSocket<SocketData>
}

function quote(symbol: string, lastPrice = 100): QuoteUpdate {
  return { symbol, lastPrice, sessionStatus: null, timestamp: 0 }
}

function book(symbol: string): DepthBook {
  return { symbol, bids: [], asks: [], buyLots: null, sellLots: null } as unknown as DepthBook
}

describe("stream hub", () => {
  test("subscribes upstream to the union of what clients want, plus the monitors", () => {
    const quotes = new FakeQuoteStream()
    const hub = new StreamHub(sessionWith(sourcesWith(quotes, new FakeDepthFactory())), {
      extraQuoteSymbols: () => ["MONITORED"],
    })

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "quotes", symbols: ["AAA"] })
    hub.handle(b, { type: "subscribe", channel: "quotes", symbols: ["BBB"] })

    expect(quotes.started.at(-1)).toEqual(["AAA", "BBB", "MONITORED"])
  })

  test("keeps the monitors' symbols after the last client leaves", () => {
    const quotes = new FakeQuoteStream()
    const hub = new StreamHub(sessionWith(sourcesWith(quotes, new FakeDepthFactory())), {
      extraQuoteSymbols: () => ["MONITORED"],
    })

    const client = socket()
    hub.add(client)
    hub.handle(client, { type: "subscribe", channel: "quotes", symbols: ["AAA"] })
    hub.remove(client)

    // A stop rule still needs its price with nobody watching.
    expect(quotes.started.at(-1)).toEqual(["MONITORED"])
    expect(quotes.stopped).toBe(0)
  })

  test("sends a quote only to the clients watching that symbol", () => {
    const quotes = new FakeQuoteStream()
    const hub = new StreamHub(sessionWith(sourcesWith(quotes, new FakeDepthFactory())))

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "quotes", symbols: ["AAA"] })
    hub.handle(b, { type: "subscribe", channel: "quotes", symbols: ["BBB"] })

    quotes.listener?.(quote("AAA"))

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
  })

  test("two clients on different depth symbols are each served their own book", () => {
    const depth = new FakeDepthFactory()
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), depth)))

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.handle(b, { type: "subscribe", channel: "depth", symbol: "BBB" })

    // One upstream connection per symbol, so neither client goes without.
    expect(depth.opened).toHaveLength(2)

    depth.forSymbol("BBB")?.listener?.(book("BBB"))
    depth.forSymbol("AAA")?.listener?.(book("AAA"))

    expect(a.sent).toEqual([{ type: "depth", book: book("AAA") }])
    expect(b.sent).toEqual([{ type: "depth", book: book("BBB") }])
  })

  test("a depth symbol nobody watches any more is stopped", () => {
    const depth = new FakeDepthFactory()
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), depth)))

    const client = socket()
    hub.add(client)
    hub.handle(client, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.handle(client, { type: "subscribe", channel: "depth", symbol: "BBB" })

    expect(depth.forSymbol("AAA")?.stopped).toBe(1)
    expect(depth.forSymbol("BBB")?.stopped).toBe(0)
  })

  test("two clients on the same depth symbol share one upstream connection", () => {
    const depth = new FakeDepthFactory()
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), depth)))

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.handle(b, { type: "subscribe", channel: "depth", symbol: "AAA" })

    expect(depth.opened).toHaveLength(1)

    depth.forSymbol("AAA")?.listener?.(book("AAA"))
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })

  test("the upstream stream survives one of two clients leaving", () => {
    const depth = new FakeDepthFactory()
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), depth)))

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.handle(b, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.remove(a)

    expect(depth.forSymbol("AAA")?.stopped).toBe(0)

    hub.remove(b)
    expect(depth.forSymbol("AAA")?.stopped).toBe(1)
  })

  test("a depth status frame reaches only the clients on that symbol", () => {
    const depth = new FakeDepthFactory()
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), depth)))

    const a = socket()
    const b = socket()
    hub.add(a)
    hub.add(b)
    hub.handle(a, { type: "subscribe", channel: "depth", symbol: "AAA" })
    hub.handle(b, { type: "subscribe", channel: "depth", symbol: "BBB" })

    // Status carries no symbol, so it is routed by the stream that reported it.
    depth.forSymbol("AAA")?.statusListener?.("live")

    expect(a.sent).toEqual([{ type: "depthStatus", status: "live" }])
    expect(b.sent).toHaveLength(0)
  })

  test("drops market data for a client that has fallen behind", () => {
    const quotes = new FakeQuoteStream()
    const hub = new StreamHub(sessionWith(sourcesWith(quotes, new FakeDepthFactory())))

    const slow = socket(2 << 20)
    hub.add(slow)
    hub.handle(slow, { type: "subscribe", channel: "quotes", symbols: ["AAA"] })

    quotes.listener?.(quote("AAA"))

    expect(slow.sent).toHaveLength(0)
    expect(slow.data.dropped).toBe(1)
  })

  test("a fired stop still reaches a client that has fallen behind", () => {
    const hub = new StreamHub(sessionWith(sourcesWith(new FakeQuoteStream(), new FakeDepthFactory())))

    const slow = socket(2 << 20)
    hub.add(slow)

    // Backpressure may cost a tick; it must never cost a stop notification.
    hub.broadcast({ type: "session", state: "expired" })

    expect(slow.sent).toEqual([{ type: "session", state: "expired" }])
  })

  test("feeds every quote to the monitors even with nobody subscribed", () => {
    const quotes = new FakeQuoteStream()
    const seen: QuoteUpdate[] = []
    const hub = new StreamHub(sessionWith(sourcesWith(quotes, new FakeDepthFactory())), {
      extraQuoteSymbols: () => ["AAA"],
      onQuote: (update) => seen.push(update),
    })
    hub.refresh()

    quotes.listener?.(quote("AAA"))

    expect(seen).toHaveLength(1)
  })

  // A stop reads what is held to decide whether to fire and how much to exit, so
  // account frames have to reach the server, not only the clients it forwards to.
  test("feeds account updates to the monitors even with nobody subscribed", () => {
    const account = new FakeAccountStream()
    const seen: AccountLiveUpdate[] = []
    const hub = new StreamHub(sessionWith(sourcesWithAccount(account)), {
      wantsAccount: () => true,
      onAccount: (update) => seen.push(update),
    })
    hub.refresh()

    account.listener?.({ type: "position", uid: "future-1", quantity: 0, averageCost: null, country: null })

    expect(seen).toEqual([{ type: "position", uid: "future-1", quantity: 0, averageCost: null, country: null }])
  })

  // The stream stopping with the last client is exactly when an unattended stop
  // is the only thing protecting the position.
  test("keeps the account stream running for the monitors when no client wants it", () => {
    const account = new FakeAccountStream()
    const hub = new StreamHub(sessionWith(sourcesWithAccount(account)), { wantsAccount: () => true })

    hub.refresh()

    expect(account.started).toBe(true)
  })

  test("stops the account stream when neither a client nor a monitor wants it", () => {
    const account = new FakeAccountStream()
    const hub = new StreamHub(sessionWith(sourcesWithAccount(account)), { wantsAccount: () => false })

    hub.refresh()

    expect(account.started).toBe(false)
  })

  /**
   * A recovery replaces every stream the last session handed out and stops the
   * old ones. Nobody resubscribes afterwards — the client stayed attached
   * throughout and saw nothing happen — so unless the hub takes the
   * subscriptions out again the socket is live and permanently silent.
   */
  test("subscribes again when the session is replaced, with no client asking", () => {
    const quotes = new FakeQuoteStream()
    const depth = new FakeDepthFactory()
    const session = sessionWith(sourcesWith(quotes, depth))
    const hub = new StreamHub(session, { wantsAccount: () => false })

    const client = socket()
    hub.add(client)
    hub.handle(client, { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] })
    hub.handle(client, { type: "subscribe", channel: "depth", symbol: "F_XU0300826" })
    expect(quotes.started).toEqual([["F_XU0300826"]])
    expect(depth.forSymbol("F_XU0300826")).toBeDefined()

    const recoveredQuotes = new FakeQuoteStream()
    const recoveredDepth = new FakeDepthFactory()
    adoptSources(session, sourcesWith(recoveredQuotes, recoveredDepth))

    // What the client asked for is watched again, on the new session's streams.
    expect(recoveredQuotes.started).toEqual([["F_XU0300826"]])
    expect(recoveredDepth.forSymbol("F_XU0300826")).toBeDefined()

    // And the quotes still reach the client, which is the whole point.
    recoveredQuotes.listener?.(quote("F_XU0300826", 305))
    expect(client.sent.at(-1)).toEqual({ type: "quotes", update: quote("F_XU0300826", 305) })
  })
})

describe("what a client is told when it arrives", () => {
  /**
   * An upstream stream announces itself only when its connectivity changes, so a
   * client subscribing to one that is already running hears nothing. It has just
   * marked every channel stale — losing the socket loses all of them — and would
   * sit showing nothing as live while data flowed past it.
   */
  test("a subscriber is told where the channel stands, not left waiting for a change", () => {
    const quotes = new FakeQuoteStream()
    const session = sessionWith(sourcesWith(quotes, new FakeDepthFactory()))
    const hub = new StreamHub(session)

    const first = socket()
    hub.add(first)
    hub.handle(first, { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] })
    // Upstream connects, and everyone attached hears about it.
    quotes.connectionListener?.(true)
    expect(first.sent.at(-1)).toEqual({ type: "status", channel: "quotes", connected: true })

    // A second client arrives afterwards, with nothing left to announce.
    const later = socket()
    hub.add(later)
    hub.handle(later, { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] })

    expect(later.sent).toContainEqual({ type: "status", channel: "quotes", connected: true })
  })

  test("a status nobody has reported yet is not invented", () => {
    const session = sessionWith(sourcesWith(new FakeQuoteStream(), new FakeDepthFactory()))
    const hub = new StreamHub(session)
    const client = socket()
    hub.add(client)

    hub.handle(client, { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] })

    expect(client.sent).toBeEmpty()
  })
})

/**
 * Each pending order opens its own upstream stream. Written straight through,
 * one terminal replaces what another is following, and a new session follows
 * nothing at all — an order's fills going unseen until something else refreshed.
 */
describe("the orders being followed", () => {
  test("are the union of what every client asked for", () => {
    const account = new FakeAccountStream()
    const hub = new StreamHub(sessionWith(sourcesWithAccount(account)))
    const first = socket()
    const second = socket()
    hub.add(first)
    hub.add(second)

    hub.handle(first, { type: "pendingOrders", orderUids: ["order-1"] })
    hub.handle(second, { type: "pendingOrders", orderUids: ["order-2"] })

    expect([...(account.pendingOrders ?? [])].sort()).toEqual(["order-1", "order-2"])
  })

  test("stop being followed when the client watching them goes", () => {
    const account = new FakeAccountStream()
    const hub = new StreamHub(sessionWith(sourcesWithAccount(account)))
    const first = socket()
    const second = socket()
    hub.add(first)
    hub.add(second)
    hub.handle(first, { type: "pendingOrders", orderUids: ["order-1"] })
    hub.handle(second, { type: "pendingOrders", orderUids: ["order-2"] })

    hub.remove(second)

    expect(account.pendingOrders).toEqual(["order-1"])
  })

  test("are handed to the stream a new session brings with it", () => {
    const account = new FakeAccountStream()
    const session = sessionWith(sourcesWithAccount(account))
    const hub = new StreamHub(session)
    const client = socket()
    hub.add(client)
    hub.handle(client, { type: "pendingOrders", orderUids: ["order-1"] })

    const recovered = new FakeAccountStream()
    adoptSources(session, sourcesWithAccount(recovered))

    expect(recovered.pendingOrders).toEqual(["order-1"])
  })
})

/**
 * What the session does to itself on a sign-in or a recovery: new sources, and
 * its listeners told. `session.test.ts` covers the real adoption raising that
 * notification; this drives what the hub does with it.
 */
function adoptSources(session: ProviderSession, sources: ProviderSources): void {
  const internals = session as unknown as { current: ProviderSources; sessionListeners: (() => void)[] }
  internals.current = sources
  for (const listener of internals.sessionListeners) listener()
}

class FakeAccountStream {
  listener: ((update: AccountLiveUpdate) => void) | null = null
  started = false
  pendingOrders: string[] | null = null

  subscribe(listener: (update: AccountLiveUpdate) => void): void {
    this.listener = listener
  }
  onConnectionChange(): void {}
  start(): void {
    this.started = true
  }
  stop(): void {
    this.started = false
  }
  setPendingOrders(orderUids: string[]): void {
    this.pendingOrders = orderUids
  }
}

function sourcesWithAccount(account: FakeAccountStream): ProviderSources {
  return {
    quotes: new FakeQuoteStream(),
    accountStream: account as unknown as AccountStream,
    openDepthStream: () => idleStream,
    openEquityQuoteStream: () => idleStream as unknown as EquityQuoteStream,
  } as unknown as ProviderSources
}
