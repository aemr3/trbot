import { describe, expect, test } from "bun:test"
import type { MarketOverviewDigest } from "@trbot/market/overview.ts"
import { isProtocolError } from "@trbot/protocol/error.ts"
import { HttpOverviewGenerator, awaitAuthorizationCode } from "./ai.ts"
import type { HttpClient } from "./http.ts"

const DIGEST = { mode: "DAILY" } as unknown as MarketOverviewDigest

/** A client that answers the overview route with exactly these frames. */
function clientStreaming(frames: unknown[]): HttpClient {
  const body = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")
  return {
    stream: () => Promise.resolve(new Response(body).body as ReadableStream<Uint8Array>),
  } as unknown as HttpClient
}

async function collect(frames: unknown[]): Promise<{ text: string; failure: Error | null }> {
  const deltas: string[] = []
  const failure = await new HttpOverviewGenerator(clientStreaming(frames))
    .generate(DIGEST, { onDelta: (text) => deltas.push(text) })
    .then(
      () => null,
      (error: unknown) => error as Error,
    )
  return { text: deltas.join(""), failure }
}

/**
 * The stream carries more than commentary. A reasoning model can think for
 * longer than the connection's idle limit before its first token, so the server
 * sends heartbeats to keep the socket alive — and the client must read straight
 * past them rather than treating them as something gone wrong.
 */
describe("the streamed overview", () => {
  test("renders the deltas and ignores the heartbeats between them", async () => {
    const { text, failure } = await collect([
      { heartbeat: true },
      { heartbeat: true },
      { delta: "Flow is " },
      { heartbeat: true },
      { delta: "one-sided." },
    ])
    expect(failure).toBeNull()
    expect(text).toBe("Flow is one-sided.")
  })

  test("ignores a frame a newer server might add", async () => {
    const { text, failure } = await collect([{ progress: 0.5 }, { delta: "still fine" }])
    expect(failure).toBeNull()
    expect(text).toBe("still fine")
  })

  test("an error frame still ends the stream, keeping what arrived before it", async () => {
    const { text, failure } = await collect([
      { heartbeat: true },
      { delta: "half an answer" },
      { error: { code: "upstream_error", message: "the model gave up" } },
    ])
    expect(text).toBe("half an answer")
    expect(isProtocolError(failure) && failure.code).toBe("upstream_error")
    expect(failure?.message).toBe("the model gave up")
  })

  test("an error frame the client cannot parse is still an error", async () => {
    const { failure } = await collect([{ error: { code: "not-a-known-code" } }])
    expect(isProtocolError(failure) && failure.code).toBe("internal")
  })
})

/**
 * The provider only redirects to a loopback address, so this listener runs on
 * the trader's machine even though the server owns the exchange. It is the one
 * piece of the login the terminal is responsible for.
 */
describe("the authorization callback listener", () => {
  test("reports the code and state the redirect carries", async () => {
    const redirectUri = await loopbackUri()
    const listener = awaitAuthorizationCode(redirectUri)
    try {
      const response = await fetch(`${redirectUri}?code=authorization-code&state=state-1`)
      expect(response.ok).toBe(true)
      expect(await listener.result).toEqual({ code: "authorization-code", state: "state-1" })
    } finally {
      listener.stop()
    }
  })

  test("fails with the provider's own message when authorization is refused", async () => {
    const redirectUri = await loopbackUri()
    const listener = awaitAuthorizationCode(redirectUri)
    // Caught before the redirect arrives, so the rejection always has a reader.
    const refused = failureOf(listener.result)
    try {
      await fetch(`${redirectUri}?error=access_denied&error_description=The+trader+said+no`)
      expect((await refused).message).toBe("The trader said no")
    } finally {
      listener.stop()
    }
  })

  test("ignores a request to any other path", async () => {
    const redirectUri = await loopbackUri()
    const listener = awaitAuthorizationCode(redirectUri)
    try {
      const stray = await fetch(new URL("/somewhere-else", redirectUri))
      expect(stray.status).toBe(404)

      await fetch(`${redirectUri}?code=authorization-code&state=state-1`)
      expect(await listener.result).toMatchObject({ code: "authorization-code" })
    } finally {
      listener.stop()
    }
  })

  test("a cancelled login stops waiting", async () => {
    const redirectUri = await loopbackUri()
    const cancel = new AbortController()
    const listener = awaitAuthorizationCode(redirectUri, cancel.signal)
    const cancelled = failureOf(listener.result)
    try {
      cancel.abort()
      expect((await cancelled).message).toContain("cancelled")
    } finally {
      listener.stop()
    }
  })
})

/**
 * The failure a promise ends in. Subscribed before the failure is triggered, so
 * a rejection never goes briefly unhandled and takes down the test run.
 */
function failureOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => new Error("expected a failure"),
    (error: unknown) => error as Error,
  )
}

/** A free loopback address, so the tests never fight over the real port 1455. */
async function loopbackUri(): Promise<string> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  await probe.stop(true)
  return `http://127.0.0.1:${port}/auth/callback`
}
