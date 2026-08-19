import { describe, expect, test } from "bun:test"
import type { MarketOverviewDigest } from "@trbot/market/overview.ts"
import { isProtocolError } from "@trbot/protocol/error.ts"
import type { AiAccountSummary } from "@trbot/protocol/ai.ts"
import { HttpAiAccount, HttpOverviewGenerator } from "./ai.ts"
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
 * The login runs here, on the trader's machine, because the provider only
 * redirects an authorization to localhost and it is their browser that has to
 * open. What this side owns is what happens around it: the address is reported so
 * a machine with no browser can follow it by hand, and the credentials go inward
 * to the server, which stores them.
 */
describe("connecting ChatGPT", () => {
  test("hands the server what the login produced and answers with its summary", async () => {
    const posted: { path: string; body: unknown }[] = []
    const summary: AiAccountSummary = {
      providerId: "openai",
      accountId: "account-1",
      connectedAt: 1_000,
      updatedAt: 1_000,
    }
    const http = {
      post: (path: string, options: { body?: unknown }) => {
        posted.push({ path, body: options.body })
        return Promise.resolve(summary)
      },
    } as unknown as HttpClient

    const urls: string[] = []
    const opened: string[] = []
    const account = new HttpAiAccount(http, {
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.openai.test/authorize?state=state-1" })
        return {
          type: "oauth",
          access: "access-1",
          refresh: "refresh-1",
          expires: 601_000,
          accountId: "account-1",
        }
      },
      // Never a real browser from a test.
      openUrl: async (url) => {
        opened.push(url)
      },
    })

    expect(await account.connect({ onAuthorizationUrl: (url) => urls.push(url) })).toEqual(summary)
    expect(urls).toEqual(["https://auth.openai.test/authorize?state=state-1"])
    // The harness only reports the address; opening it is this side's job, and it
    // has to be the same address the trader was shown.
    expect(opened).toEqual(urls)
    expect(posted).toEqual([{
      path: "/v1/ai/account",
      body: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 601_000,
        accountId: "account-1",
      },
    }])
  })

  test("a login that reports no account is still stored", async () => {
    // The account id is read out of the token by the harness. A build that stops
    // reporting one must not stop a trader connecting.
    const bodies: unknown[] = []
    const http = {
      post: (_path: string, options: { body?: unknown }) => {
        bodies.push(options.body)
        return Promise.resolve({ providerId: "openai", accountId: null, connectedAt: 1, updatedAt: 1 })
      },
    } as unknown as HttpClient
    const account = new HttpAiAccount(http, {
      login: async () => ({ type: "oauth", access: "access-1", refresh: "refresh-1", expires: 1 }),
    })

    await account.connect()
    expect(bodies).toEqual([{
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: null,
    }])
  })

  test("a trader who cancels the pasted-code prompt cancels the login", async () => {
    // The prompt is the way out when the redirect cannot be caught — no browser, or
    // the callback port already taken. Answering it with nothing means "stop", and
    // must not be sent to the server as a login that half happened.
    const http = { post: () => Promise.reject(new Error("must not reach the server")) } as unknown as HttpClient
    const account = new HttpAiAccount(http, {
      login: async (interaction) => {
        await interaction.prompt({ type: "manual_code", message: "Paste the code" })
        throw new Error("the prompt was expected to cancel the login")
      },
    })

    const failure = await account
      .connect({ onManualCode: async () => "" })
      .then(() => null, (error: unknown) => error as Error)
    expect(failure?.name).toBe("AbortError")
  })

  test("the browser flow is chosen by id, not by position", async () => {
    // The harness asks which flow to use and offers a headless one alongside the
    // browser. Answering by id means a reordered list cannot silently connect
    // through a device code the modal has nowhere to show.
    const http = {
      post: () => Promise.resolve({ providerId: "openai", accountId: null, connectedAt: 1, updatedAt: 1 }),
    } as unknown as HttpClient
    const answered: string[] = []
    const account = new HttpAiAccount(http, {
      login: async (interaction) => {
        answered.push(
          await interaction.prompt({
            type: "select",
            message: "Select login method:",
            options: [
              { id: "device_code", label: "Device code login (headless)" },
              { id: "browser", label: "Browser login" },
            ],
          }),
        )
        return { type: "oauth", access: "a", refresh: "r", expires: 1 }
      },
    })

    await account.connect()
    expect(answered).toEqual(["browser"])
  })

  test("a harness offering no browser flow fails rather than guessing", async () => {
    const http = { post: () => Promise.reject(new Error("must not reach the server")) } as unknown as HttpClient
    const account = new HttpAiAccount(http, {
      login: async (interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Select login method:",
          options: [{ id: "device_code", label: "Device code login (headless)" }],
        })
        throw new Error("the prompt was expected to fail")
      },
    })

    const failure = await account.connect().then(() => null, (error: unknown) => error as Error)
    expect(failure?.message).toBe("The harness no longer offers a browser login")
  })
})

