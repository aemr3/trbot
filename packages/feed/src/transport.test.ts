import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { FetchFeedTransport } from "./transport.ts"

let server: ReturnType<typeof Bun.serve> | null = null

const ReceivedRequestSchema = z.object({
  headers: z.record(z.string(), z.string()),
  body: z.string(),
})

afterEach(async () => {
  await server?.stop()
  server = null
})

describe("FetchFeedTransport", () => {
  test("uses one coherent browser identity without dropping feed request data", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        return Response.json({
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        }, { status: 201 })
      },
    })

    const response = await new FetchFeedTransport().request({
      url: `http://127.0.0.1:${server.port}/auth/token/`,
      method: "POST",
      token: "feed-token",
      body: { refresh: "refresh-token" },
    })

    expect(response.status).toBe(201)
    const received = ReceivedRequestSchema.parse(JSON.parse(response.body))
    expect(received.headers.authorization).toBe("Bearer feed-token")
    expect(received.headers["content-type"]).toBe("application/json")
    expect(received.body).toBe(JSON.stringify({ refresh: "refresh-token" }))
    expect(received.headers["user-agent"]).toContain("Chrome/")
    expect(received.headers["sec-ch-ua"]).toContain("Google Chrome")
    expect(received.headers["sec-fetch-mode"]).toBe("navigate")
  })
})
