import { describe, expect, test } from "bun:test"
import { CONTROL_FRAME_TYPES, type ControlFrame, type DepthFrame, type FieldFrame, type TradeFrame } from "./frames.ts"
import { MarketSocket, type SocketHandle, type SocketHandlers } from "./socket.ts"
import type { FieldUpdate } from "./socket.ts"

class FakeSocket implements SocketHandle {
  readonly sent: string[] = []
  closed = false

  constructor(readonly url: string, readonly handlers: SocketHandlers) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Drives the handshake the feed performs on every connection. */
  completeLogin(): void {
    this.handlers.onOpen()
    this.handlers.onMessage(JSON.stringify({ type: CONTROL_FRAME_TYPES.loginAccepted }))
  }

  deliver(frame: ControlFrame | FieldFrame | DepthFrame | TradeFrame): void {
    this.handlers.onMessage(JSON.stringify(frame))
  }

  /** The topics carried by every subscribe frame sent so far. */
  subscribedTopics(): string[] {
    return this.sent.flatMap((raw) => {
      const parsed: { type?: string; topics?: string[] } = JSON.parse(raw)
      return parsed.type === "subscribe" ? parsed.topics ?? [] : []
    })
  }

  unsubscribedTopics(): string[] {
    return this.sent.flatMap((raw) => {
      const parsed: { type?: string; topics?: string[] } = JSON.parse(raw)
      return parsed.type === "unsubscribe" ? parsed.topics ?? [] : []
    })
  }
}

function build() {
  const sockets: FakeSocket[] = []
  const session = { streamToken: async () => "stream-1", renewStreamToken: async () => "stream-2" }
  const socket = new MarketSocket(session, {
    url: "wss://feed.test/stream",
    reconnectDelaysMs: [10],
    socketFactory: (url, handlers) => {
      const fake = new FakeSocket(url, handlers)
      sockets.push(fake)
      return fake
    },
  })
  return { socket, sockets }
}

/** The socket opens asynchronously because it awaits the license first. */
async function settle(): Promise<void> {
  await Bun.sleep(5)
}

describe("MarketSocket", () => {
  test("carries the license in the query string and the login frame", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()

    const opened = sockets[0]!
    expect(opened.url).toBe("wss://feed.test/stream?streamtoken=stream-1")
    opened.handlers.onOpen()
    expect(JSON.parse(opened.sent[0]!)).toEqual({ type: "login", token: "stream-1" })
    socket.stop()
  })

  test("subscribes only after the login is accepted", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()
    const opened = sockets[0]!

    opened.handlers.onOpen()
    expect(opened.subscribedTopics()).toEqual([])

    opened.handlers.onMessage(JSON.stringify({ type: CONTROL_FRAME_TYPES.loginAccepted }))
    expect(opened.subscribedTopics()).toEqual(["GARAN/C"])
    socket.stop()
  })

  test("delivers field deltas to the subscriber holding that symbol", async () => {
    const { socket, sockets } = build()
    const mine: FieldUpdate[] = []
    const theirs: FieldUpdate[] = []
    socket.subscribe(["GARAN/C"], { onFields: (updates) => mine.push(...updates) })
    socket.subscribe(["THYAO/C"], { onFields: (updates) => theirs.push(...updates) })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({ k: "GARAN/C", v: 129.9 })
    expect(mine).toEqual([{ symbol: "GARAN", field: "C", value: 129.9 }])
    expect(theirs).toEqual([])
    socket.stop()
  })

  // Acknowledgements namespace topics by entitlement (`r/` for realtime) while
  // deltas arrive bare, and both have to land on the same symbol.
  test("accepts an entitlement-prefixed delta key", async () => {
    const { socket, sockets } = build()
    const seen: FieldUpdate[] = []
    socket.subscribe(["GARAN/C"], { onFields: (updates) => seen.push(...updates) })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({ k: "r/GARAN/C", v: 130.1 })
    expect(seen).toEqual([{ symbol: "GARAN", field: "C", value: 130.1 }])
    socket.stop()
  })

  test("fans the subscription snapshot out as field updates", async () => {
    const { socket, sockets } = build()
    const seen: FieldUpdate[] = []
    socket.subscribe(["GARAN/C", "GARAN/P"], { onFields: (updates) => seen.push(...updates) })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({
      type: CONTROL_FRAME_TYPES.subscribed,
      topics: ["r/GARAN/C", "r/GARAN/P"],
      data: [{ code: "GARAN", C: 129.9, P: 129.3 }],
    })

    expect(seen).toEqual([
      { symbol: "GARAN", field: "C", value: 129.9 },
      { symbol: "GARAN", field: "P", value: 129.3 },
    ])
    socket.stop()
  })

  /**
   * The opening book rides in on the acknowledgement, nested one object per
   * level. Treating those as ordinary fields loses the whole starting book, and
   * a scalar-only row schema drops the acknowledgement — and its quote snapshot
   * — entirely.
   */
  test("routes the nested opening book to the depth listeners", async () => {
    const { socket, sockets } = build()
    const levels: string[] = []
    const fields: FieldUpdate[] = []
    socket.subscribe(["F_XU0300826/ob-10", "F_XU0300826/C"], {
      onDepth: (update) => levels.push(`${update.payload.obs}${update.payload.l}@${update.payload.p}`),
      onFields: (updates) => fields.push(...updates),
    })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({
      type: CONTROL_FRAME_TYPES.subscribed,
      topics: ["r/F_XU0300826/ob-10", "r/F_XU0300826/C"],
      data: [{
        code: "F_XU0300826",
        C: 16821,
        "ob/B/0": { l: 0, obs: "B", p: 16821, c: 1, s: 5 },
        "ob/S/0": { l: 0, obs: "S", p: 16822, c: 1, s: 1 },
      }],
    })

    expect(levels).toEqual(["B0@16821", "S0@16822"])
    // The plain field still arrives, and the nested keys are not passed off as fields.
    expect(fields).toEqual([{ symbol: "F_XU0300826", field: "C", value: 16821 }])
    socket.stop()
  })

  // One license means one connection, so every consumer shares this socket.
  test("multiplexes many subscribers onto a single connection", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()
    socket.subscribe(["THYAO/C"], {})
    await settle()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.subscribedTopics()).toEqual(["GARAN/C", "THYAO/C"])
    socket.stop()
  })

  test("keeps a shared topic subscribed while another consumer still wants it", async () => {
    const { socket, sockets } = build()
    const release = socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()
    socket.subscribe(["GARAN/C"], {})

    // The second subscriber added no new topic, so nothing more was requested.
    expect(sockets[0]!.subscribedTopics()).toEqual(["GARAN/C"])
    release()
    expect(sockets[0]!.unsubscribedTopics()).toEqual([])
    socket.stop()
  })

  test("refreshes a shared topic without unsubscribing its existing consumer", async () => {
    const { socket, sockets } = build()
    const chartRelease = socket.subscribe(["GARAN/ob-10"], {})
    await settle()
    sockets[0]!.completeLogin()

    const snapshotRelease = socket.subscribe(["GARAN/ob-10"], {}, { refresh: true })
    expect(sockets[0]!.subscribedTopics()).toEqual(["GARAN/ob-10", "GARAN/ob-10"])

    snapshotRelease()
    expect(sockets[0]!.unsubscribedTopics()).toEqual([])

    chartRelease()
    expect(sockets[0]!.unsubscribedTopics()).toEqual(["GARAN/ob-10"])
    socket.stop()
  })

  test("unsubscribes a topic once the last consumer releases it", async () => {
    const { socket, sockets } = build()
    const first = socket.subscribe(["GARAN/C"], {})
    const second = socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()

    first()
    second()
    expect(sockets[0]!.unsubscribedTopics()).toEqual(["GARAN/C"])
    socket.stop()
  })

  test("batches large topic sets rather than sending one oversized frame", async () => {
    const { socket, sockets } = build()
    const topics = Array.from({ length: 450 }, (_, index) => `SYM${index}/C`)
    socket.subscribe(topics, {})
    await settle()
    sockets[0]!.completeLogin()

    const frames = sockets[0]!.sent
      .map((raw): { type?: string; topics?: string[] } => JSON.parse(raw))
      .filter((frame) => frame.type === "subscribe")
    expect(frames.map((frame) => frame.topics?.length)).toEqual([200, 200, 50])
    socket.stop()
  })

  /**
   * Losing the license is terminal: reconnecting would evict whoever now holds
   * it, and they would evict us straight back.
   */
  test("stops for good when the license is claimed elsewhere", async () => {
    const { socket, sockets } = build()
    let taken = 0
    socket.subscribe(["GARAN/C"], { onLicenseTaken: () => taken++ })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({ type: CONTROL_FRAME_TYPES.sessionTaken })
    expect(taken).toBe(1)
    expect(sockets[0]!.closed).toBe(true)

    await Bun.sleep(40)
    expect(sockets).toHaveLength(1)
  })

  test("reconnects and resubscribes after the connection drops", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.handlers.onClose()
    await Bun.sleep(40)

    expect(sockets.length).toBeGreaterThan(1)
    const reopened = sockets[sockets.length - 1]!
    reopened.completeLogin()
    expect(reopened.subscribedTopics()).toEqual(["GARAN/C"])
    socket.stop()
  })

  test("reports connection state from real frames rather than an open socket", async () => {
    const { socket, sockets } = build()
    const states: boolean[] = []
    socket.subscribe(["GARAN/C"], { onConnectionChange: (connected) => states.push(connected) })
    await settle()

    sockets[0]!.handlers.onOpen()
    expect(states).toEqual([])

    sockets[0]!.handlers.onMessage(JSON.stringify({ type: CONTROL_FRAME_TYPES.loginAccepted }))
    sockets[0]!.deliver({ k: "GARAN/C", v: 1 })
    expect(states).toEqual([true])
    socket.stop()
  })

  test("routes depth and trade frames to the symbol's subscriber", async () => {
    const { socket, sockets } = build()
    const depth: string[] = []
    const trades: string[] = []
    socket.subscribe(["GARAN/ob-10"], {
      onDepth: (update) => depth.push(update.symbol),
      onTrade: (update) => trades.push(update.symbol),
    })
    await settle()
    sockets[0]!.completeLogin()

    sockets[0]!.deliver({ ob: "GARAN", v: { obs: "bid", l: 0, p: 129.9, q: 100 } })
    sockets[0]!.deliver({ o: "GARAN", v: { p: 129.9, q: 5 } })
    expect(depth).toEqual(["GARAN"])
    expect(trades).toEqual(["GARAN"])
    socket.stop()
  })

  /**
   * A licence rotation retires the token the open socket was accepted with. The
   * connection has to be replaced while the subscriptions survive — dropping
   * them would leave the feed silently quiet with consumers still waiting.
   */
  test("redials with the new licence and keeps its subscriptions", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()

    socket.redial()
    await settle()

    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.closed).toBe(true)
    const redialed = sockets[1]!
    redialed.completeLogin()
    expect(redialed.subscribedTopics()).toEqual(["GARAN/C"])
    socket.stop()
  })

  test("does not redial when nothing is subscribed", () => {
    const { socket, sockets } = build()
    socket.redial()
    expect(sockets).toHaveLength(0)
  })

  test("ignores malformed frames instead of throwing into the socket", async () => {
    const { socket, sockets } = build()
    socket.subscribe(["GARAN/C"], {})
    await settle()
    sockets[0]!.completeLogin()

    expect(() => {
      sockets[0]!.handlers.onMessage("not json")
      sockets[0]!.handlers.onMessage(JSON.stringify([1, 2, 3]))
      sockets[0]!.handlers.onMessage("pong")
    }).not.toThrow()
    socket.stop()
  })
})
