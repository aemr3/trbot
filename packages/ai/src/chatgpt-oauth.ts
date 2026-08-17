const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_ISSUER = "https://auth.openai.com"
const DEFAULT_CALLBACK_PORT = 1455
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000

interface PkceCodes {
  verifier: string
  challenge: string
}

export interface ChatGptTokenResponse {
  idToken: string | null
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface ChatGptIdentity {
  accountId: string | null
  email: string | null
}

export interface ChatGptOAuthLoginOptions {
  signal?: AbortSignal
  onAuthorizationUrl?: (url: string) => void
  onBrowserError?: (error: unknown) => void
  openUrl?: (url: string) => Promise<void>
}

export interface ChatGptOAuth {
  login(options?: ChatGptOAuthLoginOptions): Promise<ChatGptTokenResponse>
  refresh(refreshToken: string): Promise<ChatGptTokenResponse>
}

export interface ChatGptOAuthClientOptions {
  issuer?: string
  clientId?: string
  callbackPort?: number
  timeoutMs?: number
  fetch?: HttpFetch
}

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface TokenPayload {
  id_token?: unknown
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export class ChatGptOAuthClient implements ChatGptOAuth {
  private readonly issuer: string
  private readonly clientId: string
  private readonly callbackPort: number
  private readonly timeoutMs: number
  private readonly request: HttpFetch

  constructor(options: ChatGptOAuthClientOptions = {}) {
    this.issuer = options.issuer ?? DEFAULT_ISSUER
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.request = options.fetch ?? globalThis.fetch
  }

  async login(options: ChatGptOAuthLoginOptions = {}): Promise<ChatGptTokenResponse> {
    if (options.signal?.aborted) throw abortError()
    const redirectUri = `http://localhost:${this.callbackPort}/auth/callback`
    const pkce = await generatePkce()
    const state = randomBase64Url(32)
    const authorizationUrl = this.buildAuthorizeUrl(redirectUri, pkce.challenge, state)
    let finish: ((result: ChatGptTokenResponse) => void) | null = null
    let fail: ((error: Error) => void) | null = null
    let settled = false

    const callback = new Promise<ChatGptTokenResponse>((resolve, reject) => {
      finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
    })

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.callbackPort,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 })

        const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        if (providerError) {
          fail?.(new Error(providerError))
          return htmlResponse(callbackPage("ChatGPT login failed", providerError), 400)
        }

        if (url.searchParams.get("state") !== state) {
          return htmlResponse(callbackPage("ChatGPT login failed", "The authorization state did not match."), 400)
        }

        const code = url.searchParams.get("code")
        if (!code) {
          fail?.(new Error("Missing authorization code"))
          return htmlResponse(callbackPage("ChatGPT login failed", "Missing authorization code."), 400)
        }

        try {
          const tokens = await this.exchangeCode(code, redirectUri, pkce.verifier)
          finish?.(tokens)
          return htmlResponse(callbackPage("ChatGPT connected", "You can return to trbot."))
        } catch (error) {
          const message = errorMessage(error)
          fail?.(new Error(message))
          return htmlResponse(callbackPage("ChatGPT login failed", message), 400)
        }
      },
    })

    const timeout = setTimeout(() => fail?.(new Error("ChatGPT login timed out")), this.timeoutMs)
    const onAbort = () => fail?.(abortError())
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      options.onAuthorizationUrl?.(authorizationUrl)
      if (options.openUrl) {
        try {
          await options.openUrl(authorizationUrl)
        } catch (error) {
          options.onBrowserError?.(error)
        }
      }
      return await callback
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
      server.stop(true)
    }
  }

  async refresh(refreshToken: string): Promise<ChatGptTokenResponse> {
    const response = await this.request(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
      }),
    })
    return readTokenResponse(response, refreshToken)
  }

  private buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "opencode",
    })
    return `${this.issuer}/oauth/authorize?${params}`
  }

  private async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<ChatGptTokenResponse> {
    const response = await this.request(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      }),
    })
    return readTokenResponse(response)
  }
}

export function chatGptIdentity(tokens: ChatGptTokenResponse): ChatGptIdentity {
  const idClaims = tokens.idToken ? parseJwtClaims(tokens.idToken) : null
  const accessClaims = parseJwtClaims(tokens.accessToken)
  const claims = idClaims ?? accessClaims
  return {
    accountId: accountId(idClaims) ?? accountId(accessClaims),
    email: claims?.email ?? null,
  }
}

async function readTokenResponse(response: Response, fallbackRefreshToken?: string): Promise<ChatGptTokenResponse> {
  if (!response.ok) throw new Error(`ChatGPT token request failed (${response.status})`)
  const payload = await response.json() as TokenPayload
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("ChatGPT token response did not include an access token")
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token
    ? payload.refresh_token
    : fallbackRefreshToken
  if (!refreshToken) throw new Error("ChatGPT token response did not include a refresh token")
  return {
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
    accessToken: payload.access_token,
    refreshToken,
    expiresIn: typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3_600,
  }
}

function parseJwtClaims(token: string): IdTokenClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as IdTokenClaims
  } catch {
    return null
  }
}

function accountId(claims: IdTokenClaims | null): string | null {
  return claims?.chatgpt_account_id
    ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id
    ?? claims?.organizations?.[0]?.id
    ?? null
}

async function generatePkce(): Promise<PkceCodes> {
  const verifier = randomBase64Url(64)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(digest).toString("base64url") }
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
