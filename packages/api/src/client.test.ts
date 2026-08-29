import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import {
  ApiClient,
  ApiHttpError,
  CredentialsRequiredError,
  OtpRequiredError,
  requiresAuthentication,
} from "./client.ts"
import { defineOperation } from "./graphql.ts"
import type { HttpRequest, HttpResponse, Transport } from "./transport.ts"
import { z } from "zod"

const NOW = 1_786_000_000_000
const viewerOperation = defineOperation<{ viewer: { id: string } }, Record<string, never>>(
  "viewer",
  "query",
  "query viewer { viewer { id } }",
)

describe("API authentication", () => {
  test("reads the stored member identity without authenticating", async () => {
    const store = new MemoryAuthStore(authState({ accessTokenExpiresAt: NOW - 1 }))
    const transport = new FakeTransport(() => {
      throw new Error("transport should not be called")
    })

    expect(await client(store, transport).getMemberUid()).toBe("member-1")
    expect(transport.requests).toHaveLength(0)
  })

  test("uses a stored access token while it is valid", async () => {
    const accessToken = jwt(600)
    const store = new MemoryAuthStore(authState({ accessToken, accessTokenExpiresAt: NOW + 600_000 }))
    const transport = new FakeTransport(() => {
      throw new Error("transport should not be called")
    })

    const session = await client(store, transport).authenticate()

    expect(session.accessToken).toBe(accessToken)
    expect(transport.requests).toHaveLength(0)
  })

  test("forces server-side reauthentication for an explicit login", async () => {
    const state = authState({ accessTokenExpiresAt: NOW + 3_600_000 })
    const store = new MemoryAuthStore(state)
    const nextAccessToken = jwt(900)
    const transport = new FakeTransport((request) => {
      expect(operationName(request)).toBe("refreshMemberTokenV2")
      return data({
        refreshMemberTokenV2: {
          token: { access_token: nextAccessToken, refresh_token: "refresh-new" },
        },
      })
    })

    const session = await client(store, transport).reauthenticate()

    expect(session.accessToken).toBe(nextAccessToken)
    expect(transport.requests.map(operationName)).toEqual(["refreshMemberTokenV2"])
  })

  test("does not bypass an unfinished SMS challenge during forced reauthentication", async () => {
    const store = new MemoryAuthStore(authState({
      loginReferenceCode: "reference-1",
      loginReferenceExpiresAt: NOW + 60_000,
    }))
    const transport = new FakeTransport(() => {
      throw new Error("transport should not be called")
    })

    const error = await client(store, transport).reauthenticate().catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OtpRequiredError)
    expect(error).toMatchObject({ expiresInSeconds: 60 })
    expect(transport.requests).toHaveLength(0)
  })

  test("replaces a legacy SMS challenge whose expiry was not stored", async () => {
    const store = new MemoryAuthStore(authState({
      memberUid: null,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      loginReferenceCode: "reference-old",
      loginReferenceExpiresAt: null,
    }))
    const transport = new FakeTransport((request) => {
      expect(operationName(request)).toBe("loginInitializeMemberV2")
      return data({
        loginInitializeMemberV2: {
          memberUid: "member-1",
          otp: { referenceCode: "reference-new", expirationSeconds: 180 },
        },
      })
    })

    const error = await client(store, transport).reauthenticate().catch((cause: unknown) => cause)

    expect(error).toMatchObject({ referenceCode: "reference-new", expiresInSeconds: 180 })
    expect(store.state?.loginReferenceCode).toBe("reference-new")
    expect(store.state?.loginReferenceExpiresAt).toBe(NOW + 180_000)
    expect(transport.requests.map(operationName)).toEqual(["loginInitializeMemberV2"])
  })

  test("resumes a stored access token without user credentials", async () => {
    const accessToken = jwt(600)
    const state = authState({ accessToken, accessTokenExpiresAt: NOW + 600_000 })
    const store = new MemoryAuthStore(state)
    const transport = new FakeTransport(() => {
      throw new Error("transport should not be called")
    })

    const session = await sessionClient(state.accountKey, store, transport).authenticate()

    expect(session.accessToken).toBe(accessToken)
    expect(transport.requests).toHaveLength(0)
  })

  test("rotates an expiring access token and its single-use refresh token", async () => {
    const store = new MemoryAuthStore(authState({ accessToken: jwt(10), accessTokenExpiresAt: NOW + 10_000 }))
    const nextAccessToken = jwt(900)
    const transport = new FakeTransport((request) => {
      expect(operationName(request)).toBe("refreshMemberTokenV2")
      expect(variables(request)).toEqual({ refreshToken: "refresh-old", memberId: "member-1" })
      return data({
        refreshMemberTokenV2: {
          token: { access_token: nextAccessToken, refresh_token: "refresh-new" },
        },
      })
    })

    const session = await client(store, transport).authenticate()

    expect(session).toEqual({
      accessToken: nextAccessToken,
      refreshToken: "refresh-new",
      memberUid: "member-1",
    })
    expect(store.state?.refreshToken).toBe("refresh-new")
  })

  test("recovers from an endpoint auth error and retries the endpoint once", async () => {
    const oldAccessToken = jwt(600)
    const nextAccessToken = jwt(900)
    const store = new MemoryAuthStore(authState({ accessToken: oldAccessToken, accessTokenExpiresAt: NOW + 600_000 }))
    let viewerCalls = 0
    const transport = new FakeTransport((request) => {
      switch (operationName(request)) {
        case "viewer":
          viewerCalls += 1
          if (viewerCalls === 1) {
            expect(request.headers.authorization).toBe(`Bearer ${oldAccessToken}`)
            return graphqlError(9002)
          }
          expect(request.headers.authorization).toBe(`Bearer ${nextAccessToken}`)
          return data({ viewer: { id: "member-1" } })
        case "refreshMemberTokenV2":
          return data({
            refreshMemberTokenV2: {
              token: { access_token: nextAccessToken, refresh_token: "refresh-new" },
            },
          })
        default:
          throw new Error(`unexpected operation ${operationName(request)}`)
      }
    })

    const result = await client(store, transport).call(viewerOperation, {})

    expect(result.viewer.id).toBe("member-1")
    expect(viewerCalls).toBe(2)
  })

  test("falls back to password device login when refresh is rejected", async () => {
    const store = new MemoryAuthStore(authState({ accessTokenExpiresAt: NOW - 1 }))
    const nextAccessToken = jwt(900)
    const transport = new FakeTransport((request) => {
      switch (operationName(request)) {
        case "refreshMemberTokenV2":
          return graphqlError(9005)
        case "retrieveLoginNonce":
          return data({ retrieveLoginNonce: { serverTimestamp: NOW } })
        case "deviceBindingLoginCompleteWithPasswordV2": {
          const input = variables(request)
          expect(input.phoneNumber).toBe("+905551234567")
          expect(input.password).toBe("password")
          expect(input.signature).toEqual(expect.any(String))
          return data({
            deviceBindingLoginCompleteWithPasswordV2: {
              token: { access_token: nextAccessToken, refresh_token: "refresh-new" },
            },
          })
        }
        default:
          throw new Error(`unexpected operation ${operationName(request)}`)
      }
    })

    const session = await client(store, transport).authenticate()

    expect(session.accessToken).toBe(nextAccessToken)
    expect(transport.requests.map(operationName)).toEqual([
      "refreshMemberTokenV2",
      "retrieveLoginNonce",
      "deviceBindingLoginCompleteWithPasswordV2",
    ])
  })

  test("preserves a rate-limit error from device relogin", async () => {
    const store = new MemoryAuthStore(authState({ accessTokenExpiresAt: NOW - 1 }))
    const transport = new FakeTransport((request) => {
      if (operationName(request) === "refreshMemberTokenV2") return graphqlError(9008)
      if (operationName(request) === "retrieveLoginNonce") {
        return { status: 429, body: "Unknown Error", retryAfterMs: 12_000 }
      }
      throw new Error(`unexpected operation ${operationName(request)}`)
    })

    const error = await client(store, transport).authenticate().catch((cause: unknown) => cause)

    if (!(error instanceof ApiHttpError)) throw new Error("Expected an API rate-limit error")
    expect(error.message).toBe("API rate limit reached. Retry in 12s.")
    expect(error.operationName).toBe("retrieveLoginNonce")
    expect(error.retryAfterMs).toBe(12_000)
    expect(requiresAuthentication(error)).toBe(false)
  })

  test("does not retry authentication before the provider rate limit expires", async () => {
    let now = NOW
    const store = new MemoryAuthStore(authState({ accessTokenExpiresAt: NOW - 1 }))
    const transport = new FakeTransport((request) => {
      if (operationName(request) === "refreshMemberTokenV2") return graphqlError(9008)
      if (operationName(request) === "retrieveLoginNonce") {
        return { status: 429, body: "Unknown Error", retryAfterMs: 12_000 }
      }
      throw new Error(`unexpected operation ${operationName(request)}`)
    })
    const api = new ApiClient({
      username: "+905551234567",
      password: "password",
      store,
      transport,
      now: () => now,
    })

    await api.authenticate().catch(() => {})
    const requestsAfterFirstAttempt = transport.requests.length
    now += 5_000
    const blocked = await api.authenticate().catch((cause: unknown) => cause)

    if (!(blocked instanceof ApiHttpError)) throw new Error("Expected the cached API rate-limit error")
    expect(blocked.retryAfterMs).toBe(7_000)
    expect(transport.requests).toHaveLength(requestsAfterFirstAttempt)

    now += 7_000
    await api.authenticate().catch(() => {})
    expect(transport.requests.length).toBeGreaterThan(requestsAfterFirstAttempt)
  })

  test("requests credentials instead of starting SMS login when session-only recovery fails", async () => {
    const state = authState({ accessTokenExpiresAt: NOW - 1 })
    const store = new MemoryAuthStore(state)
    const transport = new FakeTransport(() => graphqlError(9008))

    const error = await sessionClient(state.accountKey, store, transport).authenticate().catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(CredentialsRequiredError)
    expect(transport.requests.map(operationName)).toEqual(["refreshMemberTokenV2"])
  })

  test("requests an SMS code for a new device and completes the bind", async () => {
    const store = new MemoryAuthStore()
    const accessToken = jwt(900)
    const transport = new FakeTransport((request) => {
      switch (operationName(request)) {
        case "loginInitializeMemberV2":
          expect(variables(request)).toEqual({ phoneNumber: "+905551234567", password: "password" })
          return data({
            loginInitializeMemberV2: {
              memberUid: "member-1",
              otp: { referenceCode: "reference-1", expirationSeconds: 180 },
            },
          })
        case "loginCompleteBindDeviceV2":
          expect(variables(request).verificationCode).toBe("123456")
          return data({
            loginCompleteBindDeviceV2: {
              token: { access_token: accessToken, refresh_token: "refresh-new" },
            },
          })
        default:
          throw new Error(`unexpected operation ${operationName(request)}`)
      }
    })
    const api = client(store, transport)

    const error = await api.authenticate().catch((cause: unknown) => cause)
    if (!(error instanceof OtpRequiredError)) throw new Error("Expected an OTP challenge")
    expect(error.expiresInSeconds).toBe(180)
    expect(store.state?.loginReferenceCode).toBe("reference-1")
    expect(store.state?.loginReferenceExpiresAt).toBe(NOW + 180_000)
    expect(store.state?.privateKeyPem).toContain("BEGIN PRIVATE KEY")

    const session = await api.completeLogin("123456")
    expect(session.accessToken).toBe(accessToken)
    expect(store.state?.loginReferenceCode).toBeNull()
    expect(store.state?.loginReferenceExpiresAt).toBeNull()
  })

  test("coalesces concurrent refreshes", async () => {
    const store = new MemoryAuthStore(authState({ accessTokenExpiresAt: NOW - 1 }))
    let refreshes = 0
    const transport = new FakeTransport(async () => {
      refreshes += 1
      await Bun.sleep(5)
      return data({
        refreshMemberTokenV2: {
          token: { access_token: jwt(900), refresh_token: "refresh-new" },
        },
      })
    })
    const api = client(store, transport)

    await Promise.all([api.authenticate(), api.authenticate(), api.authenticate()])

    expect(refreshes).toBe(1)
  })
})

class MemoryAuthStore implements AuthStore {
  constructor(public state: AuthState | null = null) {}

  async get(accountKey: string): Promise<AuthState | null> {
    return this.state?.accountKey === accountKey ? this.state : null
  }

  async latest(): Promise<AuthState | null> {
    return this.state
  }

  async put(state: AuthState): Promise<void> {
    this.state = { ...state }
  }
}

class FakeTransport implements Transport {
  readonly requests: HttpRequest[] = []

  constructor(
    private readonly handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request)
    return this.handler(request)
  }
}

function client(store: AuthStore, transport: Transport): ApiClient {
  return new ApiClient({
    username: "+905551234567",
    password: "password",
    store,
    transport,
    now: () => NOW,
  })
}

function sessionClient(accountKey: string, store: AuthStore, transport: Transport): ApiClient {
  return new ApiClient({
    accountKey,
    store,
    transport,
    now: () => NOW,
  })
}

function authState(overrides: Partial<AuthState> = {}): AuthState {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return {
    accountKey: new Bun.CryptoHasher("sha256").update("+905551234567").digest("hex"),
    memberUid: "member-1",
    accessToken: jwt(10),
    refreshToken: "refresh-old",
    accessTokenExpiresAt: NOW + 10_000,
    deviceId: "device-1",
    userAgentUid: "agent-1",
    privateKeyPem: keys.privateKey,
    publicKeyBase64: keys.publicKey.toString("base64"),
    loginReferenceCode: null,
    loginReferenceExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function jwt(secondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + secondsFromNow })).toString("base64url")
  return `header.${payload}.signature`
}

const RequestBodySchema = z.object({
  operationName: z.string(),
  variables: z.record(z.string(), z.json()),
})

function requestBody(request: HttpRequest): z.output<typeof RequestBodySchema> {
  return RequestBodySchema.parse(JSON.parse(request.body))
}

function operationName(request: HttpRequest): string {
  return requestBody(request).operationName
}

function variables(request: HttpRequest): z.output<typeof RequestBodySchema>["variables"] {
  return requestBody(request).variables
}

function data<T>(value: T): HttpResponse {
  return { status: 200, body: JSON.stringify({ data: value }) }
}

function graphqlError(code: number): HttpResponse {
  return {
    status: 200,
    body: JSON.stringify({ errors: [{ message: "authentication required", extensions: { code } }] }),
  }
}
