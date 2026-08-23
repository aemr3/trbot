import { describe, expect, test } from "bun:test"
import { IndexImpactSnapshotSchema } from "@trbot/market/index-impact.ts"
import { FeedIndexImpactSource } from "./index-impact.ts"
import type { FieldUpdate, SocketListener, SocketSubscriber } from "./socket.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

const NOW = 1_787_500_000_000

class FakeTransport implements FeedTransport {
  readonly requests: FeedRequest[] = []

  constructor(private readonly response: FeedResponse) {}

  request(request: FeedRequest): Promise<FeedResponse> {
    this.requests.push(request)
    return Promise.resolve(this.response)
  }
}

class SnapshotSocket implements SocketSubscriber {
  readonly subscriptions: string[][] = []
  released = 0

  constructor(private readonly updates: FieldUpdate[]) {}

  subscribe(topics: string[], listener: SocketListener): () => void {
    this.subscriptions.push(topics)
    queueMicrotask(() => listener.onFields?.(this.updates))
    return () => { this.released++ }
  }
}

const COMPLETE_UPDATES: FieldUpdate[] = [
  field("XU030", "C", 1_010),
  field("XU030", "P", 1_000),
  field("XU030", "T", 123),
  field("XUTUM", "C", 2_020),
  field("XUTUM", "P", 2_000),
  field("AAA", "C", 110),
  field("AAA", "P", 100),
  field("AAA", "V", 1_000),
  field("BBB", "C", 90),
  field("BBB", "P", 100),
  field("BBB", "V", 2_000),
  field("CCC", "C", 100),
  field("CCC", "P", 100),
  field("CCC", "V", 500),
]

describe("FeedIndexImpactSource", () => {
  test("combines embedded weights with the shared quote snapshot and caches the page", async () => {
    const transport = new FakeTransport({ status: 200, body: weightPage() })
    const socket = new SnapshotSocket(COMPLETE_UPDATES)
    const source = new FeedIndexImpactSource(socket, { transport, now: () => NOW })

    const first = IndexImpactSnapshotSchema.parse(await source.loadIndexImpact("XU030"))
    await source.loadIndexImpact("XU030")

    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.url).toBe("https://fintables.com/endeksler/XU030")
    expect(socket.subscriptions).toHaveLength(2)
    expect(socket.subscriptions[0]).toHaveLength(14)
    expect(socket.subscriptions[0]).toContain("XU030/T")
    expect(socket.subscriptions[0]).toContain("AAA/V")
    expect(socket.released).toBe(2)

    expect(first).toMatchObject({
      readAt: NOW,
      marketTimestamp: 123_000,
      weightsUpdatedAt: "2026-08-21",
      index: { code: "XU030", pointChange: 10 },
      breadth: { advancing: 1, unchanged: 1, declining: 1, unavailable: 0 },
      broadMarket: { code: "XUTUM" },
      contributions: [
        { symbol: "AAA", volume: 1_000 },
        { symbol: "BBB", volume: 2_000 },
        { symbol: "CCC", impactPoints: 0, broadMarketImpactPoints: 0, volume: 500 },
      ],
    })
    expect(first.index.changePercent).toBeCloseTo(1)
    expect(first.estimatedConstituentImpactPoints).toBeCloseTo(30)
    expect(first.broadMarket.impactPoints).toBeCloseTo(20)
    expect(first.contributions[0]?.impactPoints).toBeCloseTo(60)
    expect(first.contributions[0]?.broadMarketImpactPoints).toBeCloseTo(40)
    expect(first.contributions[1]?.impactPoints).toBeCloseTo(-30)
    expect(first.contributions[1]?.broadMarketImpactPoints).toBeCloseTo(-20)
  })

  test("returns partial coverage after the opening snapshot settles", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: weightPage({ AAA: 60, MISS: 40 }, { AAA: 20, MISS: 10 }),
    })
    const updates = COMPLETE_UPDATES.filter((update) => update.symbol !== "BBB" && update.symbol !== "CCC")
    const source = new FeedIndexImpactSource(new SnapshotSocket(updates), {
      transport,
      now: () => NOW,
      snapshotSettleMs: 1,
      snapshotTimeoutMs: 50,
    })

    const snapshot = await source.loadIndexImpact("XU030")

    expect(snapshot.breadth).toEqual({ advancing: 1, unchanged: 0, declining: 0, unavailable: 1 })
    expect(snapshot.contributions.find((row) => row.symbol === "MISS")).toMatchObject({
      lastPrice: null,
      previousClose: null,
      impactPoints: null,
    })
  })

  test("rejects a page that no longer carries the external weight contract", async () => {
    const transport = new FakeTransport({ status: 200, body: "<html><body>changed</body></html>" })
    const source = new FeedIndexImpactSource(new SnapshotSocket([]), { transport })

    expect(source.loadIndexImpact("XU030")).rejects.toThrow("missing embedded index weights")
  })
})

function weightPage(
  weights: Record<string, number> = { AAA: 60, BBB: 30, CCC: 10 },
  broadWeights: Record<string, number> = { AAA: 20, BBB: 10, CCC: 5 },
): string {
  const selected = {
    title: "BİST 30",
    code: "XU030",
    weights,
    updated_at: "2026-08-21",
  }
  const broadMarket = {
    title: "BIST TUM",
    code: "XUTUM",
    weights: broadWeights,
    updated_at: "2026-08-21",
  }
  const payload = `"index":${JSON.stringify(selected)},"xutum":${JSON.stringify(broadMarket)}`
  return `<script>self.__next_f.push([1,"${payload.replaceAll('"', '\\"')}"])</script>`
}

function field(symbol: string, name: string, value: number): FieldUpdate {
  return { symbol, field: name, value }
}
