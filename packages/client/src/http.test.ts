import { afterEach, describe, expect, test } from "bun:test"
import { isProtocolError } from "@trbot/protocol/error.ts"
import { SessionStateSchema } from "@trbot/protocol/routes.ts"
import { HttpClient } from "./http.ts"

describe("HTTP response validation", () => {
  let server: ReturnType<typeof Bun.serve> | null = null

  afterEach(() => {
    void server?.stop(true)
    server = null
  })

  test("rejects valid JSON that does not match the route contract", async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ authenticated: "yes" }) })
    const client = new HttpClient({ url: `http://127.0.0.1:${server.port}`, token: "test" })

    const error = await client.get("/session", SessionStateSchema).catch((cause: unknown) => cause)

    expect(isProtocolError(error) && error.code).toBe("internal")
    expect(isProtocolError(error) && error.message).toContain("invalid response")
  })

  test("rejects a successful response whose body is not JSON", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("not json") })
    const client = new HttpClient({ url: `http://127.0.0.1:${server.port}`, token: "test" })

    const error = await client.get("/session", SessionStateSchema).catch((cause: unknown) => cause)

    expect(isProtocolError(error) && error.code).toBe("internal")
    expect(isProtocolError(error) && error.message).toContain("invalid JSON")
  })
})
