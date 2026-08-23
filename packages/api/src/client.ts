import { constants, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import { authOperations, type GraphqlOperation } from "./graphql.ts"
import { z } from "zod"
import type { HttpResponse, SseFrame, Transport } from "./transport.ts"

const AUTH_ERROR_CODES = new Set([9002, 9005, 9008, 9010])
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 120_000
const DEFAULT_AUTH_RATE_LIMIT_MS = 30_000
const API_URL = "https://api.getmidas.com"
const STREAM_URL = "https://stream.getmidas.com"
const USER_AGENT = "Midas/3.2.1 (iPhone; iOS 18.1.1; Scale/3.00) AppleWebKit/605.1.15 (KHTML, like Gecko)"
const DEVICE_MODEL = "iPhone 17 Pro Max"
const CHECKSUM_SECRET = "MGCh5U5KVD"

export interface ApiClientOptions {
  username?: string
  password?: string
  accountKey?: string
  store: AuthStore
  transport: Transport
  now?: () => number
}

export interface ApiSession {
  accessToken: string
  refreshToken: string | null
  memberUid: string
}

interface LoginCredentials {
  username: string
  password: string
}

interface ApiRequestHeaders {
  [name: string]: string
}

export class OtpRequiredError extends Error {
  constructor(
    readonly referenceCode: string,
    readonly expiresInSeconds: number | null,
  ) {
    super("An SMS verification code was sent; call completeLogin() with that code")
    this.name = "OtpRequiredError"
  }
}

export class AuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "AuthenticationError"
  }
}

export class CredentialsRequiredError extends AuthenticationError {
  constructor() {
    super("Username and password are required to restore this session")
    this.name = "CredentialsRequiredError"
  }
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly retryAfterMs?: number,
    readonly operationName?: string,
  ) {
    const retry = retryAfterMs === undefined ? "Wait a moment and try again." : `Retry in ${Math.ceil(retryAfterMs / 1_000)}s.`
    super(status === 429 ? `API rate limit reached. ${retry}` : `API returned HTTP ${status}`)
    this.name = "ApiHttpError"
  }
}

class GraphqlError extends Error {
  readonly codes: number[]

  constructor(
    readonly operationName: string,
    readonly errors: unknown[],
  ) {
    super(`API operation ${operationName} failed: ${JSON.stringify(errors)}`)
    this.name = "GraphqlError"
    this.codes = errors.flatMap((entry) => {
      const parsed = GraphqlErrorCodeSchema.safeParse(entry)
      if (!parsed.success || parsed.data.extensions?.code === undefined) return []
      const numericCode = Number(parsed.data.extensions.code)
      return Number.isFinite(numericCode) ? [numericCode] : []
    })
  }
}

export class ApiClient {
  private readonly now: () => number
  private authenticationInFlight: Promise<ApiSession> | null = null
  private authenticationRateLimit: { until: number; operationName?: string } | null = null

  constructor(private readonly options: ApiClientOptions) {
    this.now = options.now ?? Date.now
  }

  authenticate(): Promise<ApiSession> {
    return this.runAuthentication(() => this.authenticateInternal(false))
  }

  reauthenticate(): Promise<ApiSession> {
    return this.runAuthentication(() => this.authenticateInternal(true))
  }

  async completeLogin(verificationCode: string): Promise<ApiSession> {
    if (!verificationCode.trim()) throw new Error("The SMS verification code is required")

    return this.runAuthentication(async () => {
      const credentials = this.credentials()
      const state = await this.loadOrCreateState()
      if (!state.memberUid || !state.loginReferenceCode) {
        return this.initializeLogin(state)
      }

      const data = await this.request(authOperations.loginCompleteBindDeviceV2, {
        password: credentials.password,
        referenceCode: state.loginReferenceCode,
        verificationCode: verificationCode.trim(),
        memberId: state.memberUid,
        unrestrictedPublicKey: state.publicKeyBase64,
        restrictedPublicKey: null,
        biometricType: "FINGERPRINT",
        deviceModel: DEVICE_MODEL,
        deviceId: state.deviceId,
      })
      const token = data.loginCompleteBindDeviceV2?.token
      return this.persistTokens(state, token, { clearLoginChallenge: true })
    })
  }

  async call<TData, TVariables extends object>(
    operation: GraphqlOperation<TData, TVariables>,
    variables: TVariables,
    options: { signal?: AbortSignal } = {},
  ): Promise<TData> {
    const session = await this.authenticate()

    try {
      return await this.request(operation, variables, session.accessToken, options.signal)
    } catch (error) {
      if (!isApiAuthenticationError(error)) throw error
    }

    const recovered = await this.runAuthentication(() => this.authenticateInternal(true))
    return this.request(operation, variables, recovered.accessToken, options.signal)
  }

  // Opens a server-sent-events channel against the streaming host, injecting the
  // same bearer token the GraphQL calls use. Callers re-invoke this to reconnect;
  // authenticate() refreshes the token when it has expired.
  async *stream(options: { path: string; query?: Record<string, string>; signal?: AbortSignal }): AsyncGenerator<SseFrame> {
    if (!this.options.transport.stream) throw new Error("The configured transport does not support streaming")
    const session = await this.authenticate()
    const state = await this.loadOrCreateState()
    yield* this.options.transport.stream({
      url: buildStreamUrl(`${STREAM_URL}${options.path}`, options.query),
      headers: {
        accept: "text/event-stream",
        "accept-language": "tr",
        "cache-control": "no-cache",
        "user-agent": USER_AGENT,
        "x-midas-app-id": "main",
        "x-user-agent-uid": state.userAgentUid,
        authorization: `Bearer ${session.accessToken}`,
      },
      signal: options.signal,
    })
  }

  private async authenticateInternal(force: boolean): Promise<ApiSession> {
    const state = await this.loadOrCreateState()

    if (!force && hasUsableAccessToken(state, this.now())) return sessionFrom(state)
    if (state.loginReferenceCode) {
      if (!this.hasCredentials()) throw new CredentialsRequiredError()
      throw new OtpRequiredError(state.loginReferenceCode, null)
    }
    this.throwIfAuthenticationRateLimited()

    if (state.refreshToken && state.memberUid) {
      try {
        return await this.refresh(state)
      } catch (error) {
        if (!isApiAuthenticationError(error)) throw error
      }
    }

    if (state.memberUid) {
      if (!this.hasCredentials()) throw new CredentialsRequiredError()
      try {
        return await this.passwordRelogin(state)
      } catch (error) {
        if (isApiAuthenticationError(error)) {
          const resetState: AuthState = {
            ...state,
            memberUid: null,
            accessToken: null,
            refreshToken: null,
            accessTokenExpiresAt: null,
            loginReferenceCode: null,
            updatedAt: this.now(),
          }
          await this.options.store.put(resetState)
          return this.initializeLogin(resetState)
        }
        throw error
      }
    }

    return this.initializeLogin(state)
  }

  private async initializeLogin(state: AuthState): Promise<never> {
    const credentials = this.credentials()
    const data = await this.request(authOperations.loginInitializeMemberV2, {
      phoneNumber: credentials.username,
      password: credentials.password,
    })
    const login = data.loginInitializeMemberV2
    const memberUid = login?.memberUid
    const referenceCode = login?.otp?.referenceCode
    if (!memberUid || !referenceCode) {
      throw new AuthenticationError("Login initialization returned no member or OTP reference")
    }

    await this.options.store.put({
      ...state,
      memberUid,
      loginReferenceCode: referenceCode,
      updatedAt: this.now(),
    })
    throw new OtpRequiredError(referenceCode, login.otp?.expirationSeconds ?? null)
  }

  private async refresh(state: AuthState): Promise<ApiSession> {
    if (!state.refreshToken || !state.memberUid) {
      throw new AuthenticationError("Refresh credentials are missing")
    }

    const data = await this.request(authOperations.refreshMemberTokenV2, {
      refreshToken: state.refreshToken,
      memberId: state.memberUid,
    })
    return this.persistTokens(state, data.refreshMemberTokenV2?.token)
  }

  private async passwordRelogin(state: AuthState): Promise<ApiSession> {
    if (!state.memberUid) throw new AuthenticationError("Member UID is missing")
    const credentials = this.credentials()

    const nonce = await this.request(authOperations.retrieveLoginNonce, {})
    const signingDateValue = nonce.retrieveLoginNonce?.serverTimestamp
    const signingDate = Number(signingDateValue)
    if (!Number.isFinite(signingDate)) {
      throw new AuthenticationError("Login nonce returned no server timestamp")
    }

    const signature = sign("sha256", Buffer.from(`${state.deviceId}${credentials.username}${signingDate}`, "utf8"), {
      key: state.privateKeyPem,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64")
    const data = await this.request(authOperations.deviceBindingLoginCompleteWithPasswordV2, {
      memberUid: state.memberUid,
      deviceId: state.deviceId,
      phoneNumber: credentials.username,
      password: credentials.password,
      signingDate,
      signature,
    })
    return this.persistTokens(state, data.deviceBindingLoginCompleteWithPasswordV2?.token)
  }

  private async persistTokens(
    state: AuthState,
    token: { access_token?: string; refresh_token?: string } | undefined,
    options: { clearLoginChallenge?: boolean } = {},
  ): Promise<ApiSession> {
    if (!state.memberUid || !token?.access_token) {
      throw new AuthenticationError("Authentication returned no access token")
    }

    const next: AuthState = {
      ...state,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? state.refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt(token.access_token),
      loginReferenceCode: options.clearLoginChallenge ? null : state.loginReferenceCode,
      updatedAt: this.now(),
    }
    await this.options.store.put(next)
    return sessionFrom(next)
  }

  private async loadOrCreateState(): Promise<AuthState> {
    const key = this.options.accountKey ?? accountKey(this.credentials().username)
    const stored = await this.options.store.get(key)
    if (stored) return stored

    if (!this.hasCredentials()) throw new CredentialsRequiredError()

    const now = this.now()
    const keyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const state: AuthState = {
      accountKey: key,
      memberUid: null,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      deviceId: randomUUID(),
      userAgentUid: userAgentUid(),
      privateKeyPem: keyPair.privateKey,
      publicKeyBase64: keyPair.publicKey.toString("base64"),
      loginReferenceCode: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.put(state)
    return state
  }

  private hasCredentials(): boolean {
    return Boolean(this.options.username && this.options.password)
  }

  private credentials(): LoginCredentials {
    const { username, password } = this.options
    if (!username || !password) throw new CredentialsRequiredError()
    return {
      username,
      password,
    }
  }

  private async request<TData, TVariables extends object>(
    operation: GraphqlOperation<TData, TVariables>,
    variables: TVariables,
    accessToken?: string,
    signal?: AbortSignal,
  ): Promise<TData> {
    const timestamp = Math.floor(this.now() / 1000).toString()
    const checksum = new Bun.CryptoHasher("sha256")
      .update(`${operation.operationId}:${timestamp}:${CHECKSUM_SECRET}`)
      .digest("hex")
    const headers: ApiRequestHeaders = {
      accept: "multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json",
      "accept-language": "tr",
      "apollographql-client-name": "Midas",
      "apollographql-client-version": "v3.2.1",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-midas-app-id": "main",
      "x-version": "2",
      "x-user-agent-uid": (await this.loadOrCreateState()).userAgentUid,
      "x-apollo-operation-name": operation.name,
      "x-apollo-operation-id": operation.operationId,
      "x-timestamp": timestamp,
      "x-api-checksum": checksum,
    }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
    const response = await this.options.transport.request({
      url: `${API_URL}/router-graphql`,
      headers,
      body: JSON.stringify({
        operationName: operation.name,
        query: operation.document,
        variables,
      }),
      signal,
    })
    return parseResponse<TData>(operation.name, response)
  }

  private runAuthentication(work: () => Promise<ApiSession>): Promise<ApiSession> {
    if (this.authenticationInFlight) return this.authenticationInFlight
    this.authenticationInFlight = work()
      .catch((cause: unknown) => {
        if (cause instanceof ApiHttpError && cause.status === 429) {
          this.authenticationRateLimit = {
            until: this.now() + (cause.retryAfterMs ?? DEFAULT_AUTH_RATE_LIMIT_MS),
            operationName: cause.operationName,
          }
        }
        throw cause
      })
      .finally(() => {
        this.authenticationInFlight = null
      })
    return this.authenticationInFlight
  }

  private throwIfAuthenticationRateLimited(): void {
    const rateLimit = this.authenticationRateLimit
    if (!rateLimit) return
    const remaining = rateLimit.until - this.now()
    if (remaining <= 0) {
      this.authenticationRateLimit = null
      return
    }
    throw new ApiHttpError(429, "Unknown Error", remaining, rateLimit.operationName)
  }
}

const GraphqlErrorCodeSchema = z.object({
  extensions: z.object({ code: z.union([z.number(), z.string()]).optional() }).optional(),
}).loose()

const GraphqlResponseEnvelopeSchema = z.object({
  data: z.json().optional(),
  errors: z.array(z.json()).optional(),
})

function parseResponse<TData>(operationName: string, response: HttpResponse): TData {
  if (response.status < 200 || response.status >= 300) {
    throw new ApiHttpError(response.status, response.body, response.retryAfterMs, operationName)
  }

  let parsed: z.output<typeof GraphqlResponseEnvelopeSchema>
  try {
    parsed = GraphqlResponseEnvelopeSchema.parse(JSON.parse(response.body))
  } catch (cause) {
    throw new Error(`API operation ${operationName} returned invalid JSON`, { cause })
  }
  if (parsed.errors?.length) throw new GraphqlError(operationName, parsed.errors)
  if (parsed.data === undefined) throw new Error(`API operation ${operationName} returned no data`)
  // SAFETY: The persisted GraphQL document fixes TData for this operation; the
  // provider envelope has been decoded and the operation-specific caller owns
  // the tolerant normalization of its external fields.
  return parsed.data as TData
}

// Symbols are provider-safe (`F_TUPRS0826`) and the stream expects the comma
// list unescaped, so keep the query assembly plain rather than URLSearchParams.
function buildStreamUrl(base: string, query?: Record<string, string>): string {
  if (!query) return base
  const pairs = Object.entries(query).map(([key, value]) => `${key}=${value}`)
  return pairs.length > 0 ? `${base}?${pairs.join("&")}` : base
}

export function requiresAuthentication(cause: unknown): boolean {
  return cause instanceof AuthenticationError
    || cause instanceof OtpRequiredError
    || isApiAuthenticationError(cause)
}

function isApiAuthenticationError(cause: unknown): boolean {
  if (cause instanceof ApiHttpError) return cause.status === 401 || cause.status === 403
  return cause instanceof GraphqlError && cause.codes.some((code) => AUTH_ERROR_CODES.has(code))
}

function hasUsableAccessToken(state: AuthState, now: number): state is AuthState & { accessToken: string } {
  if (!state.accessToken) return false
  return state.accessTokenExpiresAt === null || state.accessTokenExpiresAt - now > ACCESS_TOKEN_EXPIRY_BUFFER_MS
}

function sessionFrom(state: AuthState): ApiSession {
  if (!state.accessToken || !state.memberUid) throw new AuthenticationError("Session is incomplete")
  return {
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    memberUid: state.memberUid,
  }
}

function accessTokenExpiresAt(accessToken: string): number | null {
  const payload = accessToken.split(".")[1]
  if (!payload) return null
  try {
    const claims = z.object({ exp: z.number().optional() }).parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    )
    return claims.exp === undefined ? null : claims.exp * 1000
  } catch {
    return null
  }
}

function userAgentUid(): string {
  const uuid = randomUUID().replaceAll("-", "")
  return Buffer.from(uuid, "hex").toString("base64url")
}

function accountKey(username: string): string {
  return new Bun.CryptoHasher("sha256").update(username.trim()).digest("hex")
}
