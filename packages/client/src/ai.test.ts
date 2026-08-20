import { describe, expect, test } from "bun:test"
import type { MarketOverviewDigest } from "@trbot/market/overview.ts"
import { isProtocolError } from "@trbot/protocol/error.ts"
import type { AiProviderSummary } from "@trbot/protocol/ai.ts"
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
 * A login runs here, on the trader's machine, because a provider only redirects an
 * authorization to localhost, it is their browser that has to open, and an API key is
 * theirs to type. What this side owns is the mapping around it: whatever the flow asks
 * for is put to the trader, and the credential goes inward to the server, which stores
 * it. One code path serves all forty providers, which is what these tests pin down.
 */
describe("connecting a provider", () => {
  const summary: AiProviderSummary = {
    providerId: "openai-codex",
    name: "OpenAI Codex",
    authTypes: ["oauth"],
    isSubscription: true,
    connected: true,
    source: "stored credential",
    accountId: "account-1",
    connectedAt: 1_000,
    updatedAt: 1_000,
  }

  function recordingHttp(posted: { path: string; body: unknown }[]): HttpClient {
    return {
      post: (path: string, _schema: unknown, options: { body?: unknown }) => {
        posted.push({ path, body: options.body })
        return Promise.resolve(summary)
      },
    } as unknown as HttpClient
  }

  test("hands the server the credential a subscription login produced", async () => {
    const posted: { path: string; body: unknown }[] = []
    const urls: string[] = []
    const opened: string[] = []
    const account = new HttpAiAccount(recordingHttp(posted), {
      login: async (providerId, authType, interaction) => {
        expect(providerId).toBe("openai-codex")
        expect(authType).toBe("oauth")
        interaction.notify({ type: "auth_url", url: "https://auth.openai.test/authorize?state=state-1" })
        return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 601_000, accountId: "account-1" }
      },
      // Never a real browser from a test.
      openUrl: async (url) => {
        opened.push(url)
      },
    })

    const connected = await account.connect("openai-codex", "oauth", {
      onAuthorizationUrl: (url) => urls.push(url),
    })

    expect(connected).toEqual(summary)
    expect(urls).toEqual(["https://auth.openai.test/authorize?state=state-1"])
    // The harness only reports the address; opening it is this side's job, and it has
    // to be the same address the trader was shown.
    expect(opened).toEqual(urls)
    expect(posted).toEqual([{
      path: "/v1/ai/providers/openai-codex",
      body: {
        providerId: "openai-codex",
        credential: { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 601_000, accountId: "account-1" },
      },
    }])
  })

  test("passes an API key through as the credential it is", async () => {
    // The other half of "whatever pi supports": most providers ask for one secret and
    // nothing else, and that has to reach the server unchanged.
    const posted: { path: string; body: unknown }[] = []
    const asked: string[] = []
    const account = new HttpAiAccount(recordingHttp(posted), {
      login: async (_providerId, _authType, interaction) => {
        const key = await interaction.prompt({ type: "secret", message: "Enter Groq API key" })
        return { type: "api_key", key }
      },
    })

    await account.connect("groq", "api_key", {
      onSecret: async (message) => {
        asked.push(message)
        return "gsk-not-a-real-key"
      },
    })

    expect(asked).toEqual(["Enter Groq API key"])
    expect(posted).toEqual([{
      path: "/v1/ai/providers/groq",
      body: { providerId: "groq", credential: { type: "api_key", key: "gsk-not-a-real-key" } },
    }])
  })

  test("puts a choice the flow offers to the trader rather than answering it", async () => {
    // Browser or device code is the trader's call: one needs a browser on this
    // machine and the other does not.
    const offered: string[] = []
    const account = new HttpAiAccount(recordingHttp([]), {
      login: async (_providerId, _authType, interaction) => {
        const method = await interaction.prompt({
          type: "select",
          message: "Select login method:",
          options: [
            { id: "browser", label: "Browser login" },
            { id: "device_code", label: "Device code login (headless)" },
          ],
        })
        offered.push(method)
        return { type: "oauth", access: "a", refresh: "r", expires: 1 }
      },
    })

    await account.connect("openai-codex", "oauth", {
      onSelect: async (_message, options) => options[1]?.id ?? "",
    })

    expect(offered).toEqual(["device_code"])
  })

  test("reports a device code so a machine with no browser can still connect", async () => {
    const codes: string[] = []
    const account = new HttpAiAccount(recordingHttp([]), {
      login: async (_providerId, _authType, interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.openai.test/device",
        })
        return { type: "oauth", access: "a", refresh: "r", expires: 1 }
      },
    })

    await account.connect("openai-codex", "oauth", {
      onDeviceCode: (code) => codes.push(`${code.userCode} at ${code.verificationUri}`),
    })

    expect(codes).toEqual(["ABCD-1234 at https://auth.openai.test/device"])
  })

  test("a trader who answers a prompt with nothing cancels the login", async () => {
    // Answering with nothing means "stop", and must not be sent to the server as a
    // login that half happened.
    const http = { post: () => Promise.reject(new Error("must not reach the server")) } as unknown as HttpClient
    const account = new HttpAiAccount(http, {
      login: async (_providerId, _authType, interaction) => {
        await interaction.prompt({ type: "secret", message: "Enter API key" })
        throw new Error("the prompt was expected to cancel the login")
      },
    })

    const failure = await account
      .connect("groq", "api_key", { onSecret: async () => "" })
      .then(() => null, (error: unknown) => error as Error)
    expect(failure?.name).toBe("AbortError")
  })

  test("a prompt nothing is listening for cancels rather than hanging", async () => {
    // A flow can ask for something this screen has no field for. Cancelling is the
    // honest outcome; waiting forever would look like a frozen terminal.
    const http = { post: () => Promise.reject(new Error("must not reach the server")) } as unknown as HttpClient
    const account = new HttpAiAccount(http, {
      login: async (_providerId, _authType, interaction) => {
        await interaction.prompt({ type: "secret", message: "Enter API key" })
        throw new Error("the prompt was expected to cancel the login")
      },
    })

    const failure = await account
      .connect("groq", "api_key")
      .then(() => null, (error: unknown) => error as Error)
    expect(failure?.name).toBe("AbortError")
  })
})
