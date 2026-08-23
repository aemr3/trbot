import { describe, expect, test } from "bun:test"
import type { AuthSession, OpenAuthSession } from "@trbot/auth/session.ts"
import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import type { AppCredentials } from "@trbot/config"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { providerSources, unusedFeed } from "./provider.test-fixture.ts"
import {
  ProviderSession,
  providerConnector,
  type ProviderSessionConnector,
  type ProviderSessionHandle,
  type ProviderSourceOptions,
  type ProviderSources,
} from "./session.ts"

function authState(): AuthState {
  return {
    accountKey: "account-1",
    memberUid: null,
    accessToken: "token",
    refreshToken: "refresh",
    accessTokenExpiresAt: null,
    deviceId: "device",
    userAgentUid: "agent",
    privateKeyPem: "key",
    publicKeyBase64: "pub",
    loginReferenceCode: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** An auth store holding `state`, so the default connector can rebuild a client from it. */
function sessionWith(state: AuthState | null, opened: { count: number }): OpenAuthSession {
  const store: AuthStore = {
    async get(): Promise<AuthState | null> {
      return state
    },
    async latest(): Promise<AuthState | null> {
      return state
    },
    async put(): Promise<void> {},
  }
  return async (): Promise<AuthSession> => {
    opened.count += 1
    return { store, close() {} }
  }
}

class TestHandle implements ProviderSessionHandle {
  closed = 0

  constructor(
    private readonly sourceFactory: (options: ProviderSourceOptions) => ProviderSources = () => providerSources(),
    private readonly authenticateResult: () => Promise<void> = async () => {},
    private readonly reauthenticateResult: () => Promise<void> = async () => {},
    private readonly completeLoginResult: () => Promise<void> = async () => {},
  ) {}

  authenticate(): Promise<void> {
    return this.authenticateResult()
  }

  reauthenticate(): Promise<void> {
    return this.reauthenticateResult()
  }

  completeLogin(): Promise<void> {
    return this.completeLoginResult()
  }

  sources(options: ProviderSourceOptions): ProviderSources {
    return this.sourceFactory(options)
  }

  close(): void {
    this.closed += 1
  }
}

class TestConnector implements ProviderSessionConnector {
  openCalls = 0
  resumeCalls = 0

  constructor(
    private readonly opened: TestHandle[] = [],
    private readonly resumed: Array<TestHandle | null> = [],
  ) {}

  async open(_openAuthSession: OpenAuthSession, _credentials: AppCredentials): Promise<ProviderSessionHandle> {
    this.openCalls += 1
    const handle = this.opened.shift()
    if (!handle) throw new Error("No test provider handle was queued for login")
    return handle
  }

  async resume(
    _openAuthSession: OpenAuthSession,
    _credentials: AppCredentials | null,
  ): Promise<ProviderSessionHandle | null> {
    this.resumeCalls += 1
    return this.resumed.shift() ?? null
  }
}

const noAuthSession: OpenAuthSession = async () => {
  throw new Error("The test connector must not open auth storage")
}

function testSession(connector: ProviderSessionConnector): ProviderSession {
  return new ProviderSession({ openAuthSession: noAuthSession, credentials: null, connector })
}

describe("provider session recovery", () => {
  test("explicit login does not reuse a stored access token", async () => {
    const username = "user"
    const state = authState()
    state.accountKey = new Bun.CryptoHasher("sha256").update(username).digest("hex")
    state.memberUid = "member-1"
    state.accessTokenExpiresAt = Date.now() + 60_000
    state.loginReferenceCode = "challenge-1"
    const session = new ProviderSession({
      openAuthSession: sessionWith(state, { count: 0 }),
      credentials: null,
      connector: providerConnector(unusedFeed()),
    })

    const error = await session.login(username, "password").catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "otp_required" })
    expect(session.authenticated).toBe(false)
  })

  test("expires and tells listeners when there are no credentials to retry with", async () => {
    const opened = { count: 0 }
    const session = new ProviderSession({
      openAuthSession: sessionWith(null, opened),
      credentials: null,
      connector: providerConnector(unusedFeed()),
    })
    let expired = 0
    session.onExpired(() => (expired += 1))

    expect(await session.recover()).toBe(false)
    expect(expired).toBe(1)
    expect(session.authenticated).toBe(false)
  })

  test("a signed-out session reports unauthenticated rather than throwing something opaque", () => {
    const session = testSession(new TestConnector())
    expect(() => session.require()).toThrow(/no provider session/)
  })

  test("concurrent recoveries share one attempt", async () => {
    const failed = new TestHandle(
      undefined,
      async () => {
        throw new Error("provider unavailable")
      },
    )
    const connector = new TestConnector([], [failed])
    const session = testSession(connector)

    const [first, second, third] = await Promise.all([session.recover(), session.recover(), session.recover()])

    expect([first, second, third]).toEqual([false, false, false])
    expect(connector.resumeCalls).toBe(1)
  })

  test("a later recovery starts a fresh attempt", async () => {
    const failure = (): TestHandle => new TestHandle(
      undefined,
      async () => {
        throw new Error("provider unavailable")
      },
    )
    const connector = new TestConnector([], [failure(), failure()])
    const session = testSession(connector)

    await session.recover()
    await session.recover()

    expect(connector.resumeCalls).toBe(2)
  })

  test("reports why a stored session could not be resumed", async () => {
    const failure = new Error("provider unavailable")
    const reports: [string, unknown][] = []
    const session = new ProviderSession({
      openAuthSession: noAuthSession,
      credentials: null,
      connector: new TestConnector([], [new TestHandle(undefined, async () => { throw failure })]),
      onError: (label, cause) => reports.push([label, cause]),
    })

    expect(await session.resume()).toBe(false)
    expect(reports).toEqual([["Session recovery", failure]])
  })

  test("adopting a session tells listeners, so streams can be subscribed again", async () => {
    const connector = new TestConnector([new TestHandle(), new TestHandle()])
    const session = testSession(connector)
    let adopted = 0
    session.onSession(() => (adopted += 1))

    await session.login("user", "password")
    expect(adopted).toBe(1)
    expect(session.authenticated).toBe(true)

    await session.login("user", "password")
    expect(adopted).toBe(2)
  })

  test("adopting a session stops every stream owned by the previous one", async () => {
    const stopped: string[] = []
    const first = new TestHandle((options) => {
      const sources = providerSources({
        quotes: { subscribe() {}, onConnectionChange() {}, start() {}, stop: () => stopped.push("quotes") },
        accountStream: {
          subscribe() {},
          onConnectionChange() {},
          setPendingOrders() {},
          start() {},
          stop: () => stopped.push("account"),
        },
      })
      const depth = sources.openDepthStream()
      const equity = sources.openEquityQuoteStream()
      sources.openDepthStream = () => {
        options.track(depth)
        return depth
      }
      sources.openEquityQuoteStream = () => {
        options.track(equity)
        return equity
      }
      depth.stop = () => stopped.push("depth")
      equity.stop = () => stopped.push("equity")
      return sources
    })
    const session = testSession(new TestConnector([first, new TestHandle()]))

    await session.login("user", "password")
    session.require().openDepthStream()
    session.require().openEquityQuoteStream()
    await session.login("user", "password")

    expect(stopped.sort()).toEqual(["account", "depth", "equity", "quotes"])
    session.close()
    expect(stopped).toHaveLength(4)
  })

  test("a successful sign-in closes an older verification challenge", async () => {
    const challenge = new TestHandle(
      undefined,
      undefined,
      async () => {
        throw new ProtocolError("otp_required", "verification required")
      },
    )
    const session = testSession(new TestConnector([challenge, new TestHandle()]))

    await expect(session.login("user", "password")).rejects.toMatchObject({ code: "otp_required" })
    await session.login("user", "password")

    expect(challenge.closed).toBe(1)
    await expect(session.completeOtp("123456")).rejects.toThrow(/No sign-in is waiting/)
  })

  test("expiring twice still notifies, so a client that reconnects is told", () => {
    const session = testSession(new TestConnector())
    let expired = 0
    session.onExpired(() => (expired += 1))

    session.expire()
    session.expire()

    expect(expired).toBe(2)
  })
})
