import { expect, test } from "bun:test"
import { FeedShortSaleSource } from "./short-sales.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

test("reads and normalizes short-sale activity", async () => {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      return {
        status: 200,
        body: JSON.stringify({
          start: "2026-08-20 00:00:00",
          end: "2026-08-21 00:00:00",
          results: [{
            code: "AKBNK",
            volume: 400,
            total_volume: 1_000,
            lot: 20,
            total_lot: 80,
            avg_price: 20,
            total_avg_price: 19.5,
          }],
        }),
      }
    },
  }
  const source = new FeedShortSaleSource(
    { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" },
    { transport, baseUrl: "https://feed.test" },
  )

  await expect(source.listShortSales({ start: "2026-08-20", end: "2026-08-21" })).resolves.toEqual({
    startDate: "2026-08-20",
    endDate: "2026-08-21",
    activities: [{
      symbol: "AKBNK",
      shortSaleLots: 20,
      totalLots: 80,
      shortSaleVolume: 400,
      totalVolume: 1_000,
      shortSaleAveragePrice: 20,
      marketAveragePrice: 19.5,
      shortSaleLotSharePercent: 25,
      shortSaleVolumeSharePercent: 40,
    }],
  })
  expect(requests[0]?.token).toBe("access-1")
  expect(requests[0]?.url).toBe("https://feed.test/short-sell-stats/?start=2026-08-20&end=2026-08-21")
})

test("rejects a reversed short-sale range before making a request", async () => {
  let requested = false
  const source = new FeedShortSaleSource(
    { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" },
    {
      baseUrl: "https://feed.test",
      transport: {
        async request(): Promise<FeedResponse> {
          requested = true
          throw new Error("not called")
        },
      },
    },
  )

  await expect(source.listShortSales({ start: "2026-08-21", end: "2026-08-20" }))
    .rejects.toThrow("cannot precede")
  expect(requested).toBe(false)
})
