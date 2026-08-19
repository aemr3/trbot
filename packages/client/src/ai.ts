import { InMemoryCredentialStore, createModels, type Credential, type OAuthAuth } from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import type {
  MarketOverviewDigest,
  OverviewGenerateOptions,
  OverviewGenerator,
} from "@trbot/market/overview.ts"
import type { AiAccount, AiAccountSummary, AiCredentials, AiLoginOptions } from "@trbot/protocol/ai.ts"
import { ProtocolError, parseErrorBody } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { openExternalUrl } from "./browser.ts"
import type { HttpClient } from "./http.ts"

/**
 * The authorization method this application answers with.
 *
 * The harness offers a browser flow and a headless device-code flow, and asks
 * which to use. The terminal answers for the trader rather than passing the
 * question on: the connection modal is built around the browser flow, and its
 * pasted-code field already covers the machine whose browser never opens.
 */
const BROWSER_LOGIN_METHOD = "browser"

/**
 * Running the provider's authorization flow on this machine.
 *
 * Named as a seam because it reaches well outside the process — it binds a
 * loopback listener and exchanges a single-use code — so a test can drive the
 * mapping around it without performing a real authorization.
 */
export type ChatGptLogin = OAuthAuth["login"]

/**
 * The harness's own login, run through a credential store that forgets.
 *
 * The harness persists what a login produced, which is exactly what this side
 * must not do — so the store it writes to is in memory and dies with the process.
 * What survives is the credential it returns, which goes straight to the server.
 */
function harnessLogin(): ChatGptLogin {
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  models.setProvider(openaiCodexProvider())
  return async (interaction) => asOAuthCredential(await models.login(CHATGPT_PROVIDER, "oauth", interaction))
}

/** The harness's id for the ChatGPT-subscription provider. */
const CHATGPT_PROVIDER = "openai-codex"

function asOAuthCredential(credential: Credential): Awaited<ReturnType<ChatGptLogin>> {
  if (credential.type !== "oauth") {
    throw new Error("The ChatGPT login produced an API key, which this application cannot use")
  }
  return credential
}

export interface HttpAiAccountOptions {
  login?: ChatGptLogin
  /**
   * Opening the authorization page. Injectable because it reaches outside the
   * process: a test that drove a login would otherwise open a real browser.
   */
  openUrl?: (url: string) => Promise<void>
}

/**
 * The ChatGPT connection: logged in here, owned by the server.
 *
 * The whole login runs on this machine because that is where it has to: the
 * provider will only redirect an authorization to `localhost`, and it is the
 * trader's browser that has to be opened. What crosses the wire afterwards is the
 * result — travelling inward, the same direction as the provider password on the
 * sign-in route — and the server stores it, refreshes it, and never hands it back.
 * Nothing is kept here.
 */
export class HttpAiAccount implements AiAccount {
  private readonly login: ChatGptLogin
  private readonly openUrl: (url: string) => Promise<void>

  constructor(
    private readonly http: HttpClient,
    options: HttpAiAccountOptions = {},
  ) {
    this.login = options.login ?? harnessLogin()
    this.openUrl = options.openUrl ?? openExternalUrl
  }

  getState(): Promise<AiAccountSummary | null> {
    return this.http.get<AiAccountSummary | null>(ROUTES.aiAccount)
  }

  async connect(options: AiLoginOptions = {}): Promise<AiAccountSummary> {
    const credentials = await this.login({
      // Required by the harness, which cancels the whole flow through it. Without
      // one from the caller there is nothing to cancel, so an unused signal
      // stands in rather than the flow becoming uncancellable.
      signal: options.signal ?? new AbortController().signal,
      notify: (event) => {
        if (event.type !== "auth_url") return
        options.onAuthorizationUrl?.(event.url)
        // The harness only reports the address; opening it is this side's job.
        // A machine with no browser is not a failure: the modal shows the link,
        // and the prompt below takes a code pasted back by hand.
        void this.openUrl(event.url).catch((error: unknown) => options.onBrowserError?.(error))
      },
      prompt: async (prompt) => {
        // Answered here rather than shown to the trader: see BROWSER_LOGIN_METHOD.
        // Matched by id so a reordered list cannot silently pick the other flow.
        if (prompt.type === "select") {
          const browser = prompt.options.find((option) => option.id === BROWSER_LOGIN_METHOD)
          if (!browser) throw new Error("The harness no longer offers a browser login")
          return browser.id
        }
        if (!options.onManualCode) throw abortError()
        const code = await options.onManualCode(prompt.message)
        if (!code) throw abortError()
        return code
      },
    })

    const stored: AiCredentials = {
      accessToken: credentials.access,
      refreshToken: credentials.refresh,
      expiresAt: credentials.expires,
      accountId: typeof credentials.accountId === "string" ? credentials.accountId : null,
    }
    return await this.http.post<AiAccountSummary>(ROUTES.aiAccount, {
      body: stored,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async disconnect(): Promise<void> {
    await this.http.delete(ROUTES.aiAccount)
  }
}

/** Streams the server's commentary, which the model produces a piece at a time. */
export class HttpOverviewGenerator implements OverviewGenerator {
  constructor(private readonly http: HttpClient) {}

  async generate(digest: MarketOverviewDigest, options: OverviewGenerateOptions): Promise<void> {
    const stream = await this.http.stream(ROUTES.overview, { body: digest, signal: options.signal })
    for await (const line of readLines(stream)) {
      const frame: unknown = JSON.parse(line)
      if (!frame || typeof frame !== "object") continue

      const delta = (frame as { delta?: unknown }).delta
      if (typeof delta === "string") {
        options.onDelta(delta)
        continue
      }

      // A failure part way through a response arrives as a frame, since the
      // status was already sent.
      if ("error" in frame) {
        throw parseErrorBody(frame) ?? new ProtocolError("internal", "The overview stream failed")
      }

      // Anything else is a heartbeat, or a frame from a newer server. Both are
      // ignored on purpose: only an error frame ends the stream early.
    }
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf("\n")
    }
  }
  const rest = buffer.trim()
  if (rest) yield rest
}

function abortError(): DOMException {
  return new DOMException("ChatGPT login cancelled", "AbortError")
}
