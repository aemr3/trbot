import { describe, expect, test } from "bun:test"
import { FeedSession, withStreamToken } from "./session.ts"
import { FeedUnauthorizedError, type FeedRequest, type FeedResponse, type FeedTransport } from "./transport.ts"

interface Reply {
  status: number
  body: string
}

class StubTransport implements FeedTransport {
  readonly requests: FeedRequest[] = []

  constructor(private readonly replies: Map<string, Reply[]>) {}

  async request(request: FeedRequest): Promise<FeedResponse> {
    this.requests.push(request)
    const path = new URL(request.url).pathname
    const queue = this.replies.get(path)
    if (!queue || queue.length === 0) throw new Error(`no stubbed reply for ${path}`)
    const reply = queue.length === 1 ? queue[0]! : queue.shift()!
    return { status: reply.status, body: reply.body }
  }
}

function checkBody(streamToken: string, subjects: string[] = ["prices.realtime", "orderbook.pay-10"]): string {
  return JSON.stringify({
    user: { id: 1, email: "trader@example.com", stream_token: streamToken },
    permissions: subjects.map((subject) => ({ action: "read", subject })),
  })
}

function session(replies: Map<string, Reply[]>, onStreamTokenRotated?: (token: string) => void) {
  const transport = new StubTransport(replies)
  return {
    transport,
    feed: new FeedSession({
      credentials: { username: "trader@example.com", password: "secret" },
      transport,
      onStreamTokenRotated,
    }),
  }
}

describe("FeedSession", () => {
  test("logs in and derives the license token from the session check", async () => {
    const { feed, transport } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "access-1", refresh: "refresh-1" }) }]],
      ["/auth/check/", [{ status: 200, body: checkBody("stream-1") }]],
    ]))

    expect(await feed.streamToken()).toBe("stream-1")
    expect(await feed.accessToken()).toBe("access-1")
    // The license is read with the access token, never the other way round.
    const check = transport.requests.find((request) => request.url.includes("/auth/check/"))
    expect(check?.token).toBe("access-1")
  })

  test("reports the entitlements that decide live prices and depth", async () => {
    const { feed } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
      ["/auth/check/", [{ status: 200, body: checkBody("stream-1") }]],
    ]))

    await feed.streamToken()
    expect(feed.entitlements?.realtimePrices).toBe(true)
    expect(feed.entitlements?.depth).toBe(true)
  })

  test("reports missing realtime entitlement rather than assuming it", async () => {
    const { feed } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
      ["/auth/check/", [{ status: 200, body: checkBody("stream-1", ["company.sheets"]) }]],
    ]))

    await feed.streamToken()
    expect(feed.entitlements?.realtimePrices).toBe(false)
    expect(feed.entitlements?.depth).toBe(false)
  })

  // A burst of first reads must not fire several logins at the same account.
  test("collapses concurrent first reads into one login", async () => {
    const { feed, transport } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
      ["/auth/check/", [{ status: 200, body: checkBody("stream-1") }]],
    ]))

    const tokens = await Promise.all([feed.streamToken(), feed.streamToken(), feed.streamToken()])
    expect(tokens).toEqual(["stream-1", "stream-1", "stream-1"])
    expect(transport.requests.filter((request) => request.url.includes("/auth/token/"))).toHaveLength(1)
  })

  test("re-reads the license without a fresh login when the access token still works", async () => {
    const { feed, transport } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
      ["/auth/check/", [
        { status: 200, body: checkBody("stream-1") },
        { status: 200, body: checkBody("stream-2") },
      ]],
    ]))

    await feed.streamToken()
    expect(await feed.renewStreamToken()).toBe("stream-2")
    expect(transport.requests.filter((request) => request.url.includes("/auth/token/"))).toHaveLength(1)
  })

  test("refreshes the access token when the session check rejects it", async () => {
    const { feed, transport } = session(new Map([
      ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "old", refresh: "refresh-1" }) }]],
      ["/auth/token/refresh/", [{ status: 200, body: JSON.stringify({ access: "new" }) }]],
      ["/auth/check/", [
        { status: 200, body: checkBody("stream-1") },
        { status: 401, body: JSON.stringify({ detail: "expired" }) },
        { status: 200, body: checkBody("stream-3") },
      ]],
    ]))

    await feed.streamToken()
    expect(await feed.renewStreamToken()).toBe("stream-3")
    expect(transport.requests.some((request) => request.url.includes("/auth/token/refresh/"))).toBe(true)
  })

  test("falls back to a full login when the refresh token is dead too", async () => {
    const { feed } = session(new Map([
      ["/auth/token/", [
        { status: 200, body: JSON.stringify({ access: "old", refresh: "refresh-1" }) },
        { status: 200, body: JSON.stringify({ access: "fresh", refresh: "refresh-2" }) },
      ]],
      ["/auth/token/refresh/", [{ status: 401, body: JSON.stringify({ detail: "invalid" }) }]],
      ["/auth/check/", [
        { status: 200, body: checkBody("stream-1") },
        { status: 401, body: JSON.stringify({ detail: "expired" }) },
        { status: 200, body: checkBody("stream-4") },
      ]],
    ]))

    await feed.streamToken()
    expect(await feed.renewStreamToken()).toBe("stream-4")
  })

  // Open streams are bound to a license, so a rotation has to be announced.
  test("announces a rotated license", async () => {
    const seen: string[] = []
    const { feed } = session(
      new Map([
        ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
        ["/auth/check/", [
          { status: 200, body: checkBody("stream-1") },
          { status: 200, body: checkBody("stream-2") },
        ]],
      ]),
      (token) => seen.push(token),
    )

    await feed.streamToken()
    await feed.renewStreamToken()
    expect(seen).toEqual(["stream-2"])
  })

  /**
   * The first login is not a rotation. Announcing it would cancel a connection a
   * consumer had already started, leaving the stream silently dead.
   */
  test("says nothing on the first login", async () => {
    const seen: string[] = []
    const { feed } = session(
      new Map([
        ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
        ["/auth/check/", [{ status: 200, body: checkBody("stream-1") }]],
      ]),
      (token) => seen.push(token),
    )

    await feed.streamToken()
    expect(seen).toEqual([])
  })

  test("does not announce an unchanged license", async () => {
    const seen: string[] = []
    const { feed } = session(
      new Map([
        ["/auth/token/", [{ status: 200, body: JSON.stringify({ access: "a", refresh: "r" }) }]],
        ["/auth/check/", [{ status: 200, body: checkBody("stream-1") }]],
      ]),
      (token) => seen.push(token),
    )

    await feed.streamToken()
    await feed.renewStreamToken()
    expect(seen).toEqual([])
  })
})

describe("withStreamToken", () => {
  test("renews the license once and retries a rejected read", async () => {
    const tokens = ["stale", "fresh"]
    const stub = {
      streamToken: async () => tokens[0]!,
      renewStreamToken: async () => tokens[1]!,
    }
    const used: string[] = []

    const value = await withStreamToken(stub, async (token) => {
      used.push(token)
      if (token === "stale") throw new FeedUnauthorizedError("https://example.test", "Yetkiniz bulunmuyor")
      return "candles"
    })

    expect(value).toBe("candles")
    expect(used).toEqual(["stale", "fresh"])
  })

  // A retry loop on a genuine outage would hammer the feed.
  test("does not retry failures that are not about the license", async () => {
    let calls = 0
    const stub = { streamToken: async () => "token", renewStreamToken: async () => "other" }

    await expect(withStreamToken(stub, async () => {
      calls++
      throw new Error("connection reset")
    })).rejects.toThrow("connection reset")
    expect(calls).toBe(1)
  })
})
