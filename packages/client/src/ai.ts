import type {
  MarketOverviewDigest,
  OverviewGenerateOptions,
  OverviewGenerator,
} from "@trbot/market/overview.ts"
import type { AiAccount, AiAccountSummary, AiLoginOptions, AiLoginStart } from "@trbot/protocol/ai.ts"
import { ProtocolError, parseErrorBody } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { openExternalUrl } from "./browser.ts"
import type { HttpClient } from "./http.ts"

/** How long the redirect listener waits before giving the port back. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000

/**
 * The ChatGPT connection, driven from the terminal but owned by the server.
 *
 * The server builds the authorization and exchanges the code; this side only
 * does what has to happen where the trader is sitting — open the browser and
 * catch the loopback redirect the provider insists on. No token passes through
 * here, only a single-use authorization code.
 */
export class HttpAiAccount implements AiAccount {
  constructor(private readonly http: HttpClient) {}

  getState(): Promise<AiAccountSummary | null> {
    return this.http.get<AiAccountSummary | null>(ROUTES.aiAccount)
  }

  async connect(options: AiLoginOptions = {}): Promise<AiAccountSummary> {
    const login = await this.http.post<AiLoginStart>(ROUTES.aiLogin, { signal: options.signal })
    options.onAuthorizationUrl?.(login.authorizationUrl)

    const callback = awaitAuthorizationCode(login.redirectUri, options.signal)
    try {
      try {
        await openExternalUrl(login.authorizationUrl)
      } catch (error) {
        // A machine with no browser is not a failure: the modal shows the link.
        options.onBrowserError?.(error)
      }
      const { code, state } = await callback.result
      return await this.http.post<AiAccountSummary>(ROUTES.aiLoginCallback, {
        body: { loginId: login.loginId, code, state },
      })
    } finally {
      callback.stop()
    }
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

interface AuthorizationCode {
  code: string
  state: string
}

interface CallbackListener {
  result: Promise<AuthorizationCode>
  stop: () => void
}

/**
 * Listens on the loopback address the provider redirects to and reports what it
 * receives. The port is fixed by the provider's registered redirect URI, so a
 * second login attempt while one is running will fail to bind.
 */
export function awaitAuthorizationCode(redirectUri: string, signal?: AbortSignal): CallbackListener {
  const address = new URL(redirectUri)
  let settle: ((code: AuthorizationCode) => void) | null = null
  let reject: ((error: Error) => void) | null = null
  let settled = false

  const result = new Promise<AuthorizationCode>((resolve, fail) => {
    settle = (code) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    reject = (error) => {
      if (settled) return
      settled = true
      fail(error)
    }
  })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(address.port),
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname !== address.pathname) return new Response("Not found", { status: 404 })

      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      if (failure) {
        reject?.(new Error(failure))
        return htmlResponse(callbackPage("ChatGPT login failed", failure), 400)
      }

      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) {
        reject?.(new Error("Missing authorization code"))
        return htmlResponse(callbackPage("ChatGPT login failed", "Missing authorization code."), 400)
      }

      settle?.({ code, state })
      return htmlResponse(callbackPage("ChatGPT connected", "You can return to trbot."))
    },
  })

  const timeout = setTimeout(() => reject?.(new Error("ChatGPT login timed out")), CALLBACK_TIMEOUT_MS)
  const onAbort = (): void => reject?.(abortError())
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()

  return {
    result,
    stop: () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      void server.stop(true)
    },
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

function callbackPage(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;background:#101010;color:#eee;padding:3rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`
}

function htmlResponse(content: string, status = 200): Response {
  return new Response(content, { status, headers: { "Content-Type": "text/html; charset=utf-8" } })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character)
}

function abortError(): DOMException {
  return new DOMException("ChatGPT login cancelled", "AbortError")
}
