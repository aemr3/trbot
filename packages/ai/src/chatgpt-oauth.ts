const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_ISSUER = "https://auth.openai.com"

/**
 * The provider only accepts a loopback redirect, and only on this port. The
 * server hands the address to the client, which is where the browser and the
 * listener that catches the redirect actually run.
 */
const CHATGPT_CALLBACK_PORT = 1455
const CHATGPT_CALLBACK_PATH = "/auth/callback"

export function chatGptRedirectUri(port = CHATGPT_CALLBACK_PORT): string {
  return `http://localhost:${port}${CHATGPT_CALLBACK_PATH}`
}

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

/**
 * An authorization waiting to be finished. The verifier and state never leave
 * the server: they are what stop a stray callback from completing a login.
 */
export interface ChatGptAuthorization {
  authorizationUrl: string
  verifier: string
  state: string
}

export interface ChatGptOAuth {
  authorize(redirectUri: string): Promise<ChatGptAuthorization>
  exchange(code: string, redirectUri: string, verifier: string): Promise<ChatGptTokenResponse>
  refresh(refreshToken: string): Promise<ChatGptTokenResponse>
}

export interface ChatGptOAuthClientOptions {
  issuer?: string
  clientId?: string
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

/**
 * The provider half of the ChatGPT login: it builds the authorization URL and
 * trades the code for tokens. Opening a browser and catching the redirect are
 * the client's job, because that is where the trader is sitting.
 */
export class ChatGptOAuthClient implements ChatGptOAuth {
  private readonly issuer: string
  private readonly clientId: string
  private readonly request: HttpFetch

  constructor(options: ChatGptOAuthClientOptions = {}) {
    this.issuer = options.issuer ?? DEFAULT_ISSUER
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.request = options.fetch ?? globalThis.fetch
  }

  async authorize(redirectUri: string): Promise<ChatGptAuthorization> {
    const pkce = await generatePkce()
    const state = randomBase64Url(32)
    return {
      authorizationUrl: this.buildAuthorizeUrl(redirectUri, pkce.challenge, state),
      verifier: pkce.verifier,
      state,
    }
  }

  async exchange(code: string, redirectUri: string, verifier: string): Promise<ChatGptTokenResponse> {
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
