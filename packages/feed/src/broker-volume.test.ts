import { expect, test } from "bun:test"
import { FeedBrokerVolumeSource } from "./broker-volume.ts"
import type { FeedRequest, FeedResponse, FeedTransport } from "./transport.ts"

test("selects one market and derives broker volume changes", async () => {
  const requests: FeedRequest[] = []
  const transport: FeedTransport = {
    async request(request: FeedRequest): Promise<FeedResponse> {
      requests.push(request)
      return {
        status: 200,
        body: JSON.stringify({
          latest_date: "2026-08-21",
          results: [{
            code: "YKR",
            title: "Yapı Kredi Yatırım",
            latest_volume: { pay: 90, viop: 120, total: 210 },
            current_quarter_volume_avg: { pay: 100, viop: 100, total: 200 },
            prev_quarter_volume_avg: { pay: 80, viop: 80, total: 160 },
            latest_volume_percentage: { pay: 0.1, viop: 0.25, total: 0.15 },
          }],
        }),
      }
    },
  }
  const source = new FeedBrokerVolumeSource(
    { accessToken: async () => "access-1", renewAccessToken: async () => "access-2" },
    { transport, baseUrl: "https://feed.test" },
  )

  const snapshot = await source.listBrokerVolumes("VIOP")

  expect(snapshot).toEqual({
    market: "VIOP",
    latestDate: "2026-08-21",
    brokers: [{
      code: "YKR",
      name: "Yapı Kredi Yatırım",
      marketSharePercent: 25,
      latestVolume: 120,
      currentQuarterAverageVolume: 100,
      previousQuarterAverageVolume: 80,
      latestVsQuarterAveragePercent: 20,
      currentVsPreviousQuarterPercent: 25,
    }],
  })
  expect(requests[0]?.url).toBe("https://feed.test/brokerages/volumes/")
  expect(requests[0]?.token).toBe("access-1")
})

test("keeps unavailable broker volumes nullable", async () => {
  const transport: FeedTransport = {
    async request(): Promise<FeedResponse> {
      return {
        status: 200,
        body: JSON.stringify({
          latest_date: "2026-08-21",
          results: [{
            code: "NEW",
            title: "New Broker",
            latest_volume: { pay: null, viop: null, total: null },
            current_quarter_volume_avg: { pay: null, viop: null, total: null },
            prev_quarter_volume_avg: { pay: null, viop: null, total: null },
            latest_volume_percentage: { pay: 0, viop: 0, total: 0 },
          }],
        }),
      }
    },
  }
  const source = new FeedBrokerVolumeSource(
    { accessToken: async () => "access", renewAccessToken: async () => "renewed" },
    { transport, baseUrl: "https://feed.test" },
  )

  expect((await source.listBrokerVolumes("VIOP")).brokers[0]).toMatchObject({
    latestVolume: null,
    latestVsQuarterAveragePercent: null,
    currentVsPreviousQuarterPercent: null,
  })
})
