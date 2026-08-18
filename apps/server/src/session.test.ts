import { describe, expect, test } from "bun:test"
import type { AuthSession } from "@trbot/auth/session.ts"
import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import { ProviderSession } from "./session.ts"

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

/** An auth store holding `state`, so `resumeApiClient` builds a client from it. */
function sessionWith(state: AuthState | null, opened: { count: number }): () => Promise<AuthSession> {
  const store: AuthStore = {
    async get(): Promise<AuthState | null> {
      return state
    },
    async latest(): Promise<AuthState | null> {
      return state
    },
    async put(): Promise<void> {},
  }
  return async () => {
    opened.count += 1
    return { store, close() {} }
  }
}

/** Takes the session through what a sign-in or a recovery does to it. */
function adopt(session: ProviderSession): void {
  const internals = session as unknown as { adopt(handle: { client: unknown; close(): void }): void }
  internals.adopt({ client: {}, close() {} })
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
    })

    const error = await session.login(username, "password").catch((reason: unknown) => reason)

    expect(error).toMatchObject({ code: "otp_required" })
    expect(session.authenticated).toBe(false)
  })

  test("expires and tells listeners when there are no credentials to retry with", async () => {
    const opened = { count: 0 }
    const session = new ProviderSession({ openAuthSession: sessionWith(null, opened), credentials: null })
    let expired = 0
    session.onExpired(() => (expired += 1))

    expect(await session.recover()).toBe(false)
    expect(expired).toBe(1)
    expect(session.authenticated).toBe(false)
  })

  test("a signed-out session reports unauthenticated rather than throwing something opaque", () => {
    const session = new ProviderSession({ openAuthSession: sessionWith(null, { count: 0 }), credentials: null })
    expect(() => session.require()).toThrow(/no provider session/)
  })

  test("concurrent recoveries share one attempt", async () => {
    const opened = { count: 0 }
    const session = new ProviderSession({
      openAuthSession: sessionWith(authState(), opened),
      // Credentials make it try, and the attempt fails because no provider is
      // reachable from a test — which is the path being measured.
      credentials: { username: "u", password: "p" },
    })

    const [first, second, third] = await Promise.all([session.recover(), session.recover(), session.recover()])

    expect([first, second, third]).toEqual([false, false, false])
    // One shared attempt, not three: a burst of failing requests must not start
    // a login storm against the provider.
    expect(opened.count).toBe(1)
  })

  test("a later recovery starts a fresh attempt", async () => {
    const opened = { count: 0 }
    const session = new ProviderSession({
      openAuthSession: sessionWith(authState(), opened),
      credentials: { username: "u", password: "p" },
    })

    await session.recover()
    await session.recover()

    expect(opened.count).toBe(2)
  })

  /**
   * A recovery happens on its own, so nothing afterwards would resubscribe: the
   * old streams have been stopped, every source object has been replaced, and
   * any client is still attached to a socket that has simply gone quiet.
   *
   * This drives the real adoption rather than a stand-in for it, with a handle
   * carrying no client — building the sources touches nothing.
   */
  test("adopting a session tells its listeners, so the streams can be taken out again", () => {
    const session = new ProviderSession({ openAuthSession: sessionWith(null, { count: 0 }), credentials: null })
    let adopted = 0
    session.onSession(() => (adopted += 1))

    adopt(session)
    expect(adopted).toBe(1)
    expect(session.authenticated).toBe(true)

    // A second sign-in replaces the sources again, so it has to be announced again.
    adopt(session)
    expect(adopted).toBe(2)
  })

  /**
   * A sign-in over a session that is still live — the trader signing in again
   * while the server holds a working session — must not leave the old streams
   * connected. They would keep a second set of subscriptions open against the
   * provider, and the per-symbol ones would never be stopped by anything.
   */
  test("adopting a session stops the streams the last one handed out", () => {
    const session = new ProviderSession({ openAuthSession: sessionWith(null, { count: 0 }), credentials: null })
    const stopped: string[] = []
    const previous = {
      quotes: { stop: () => stopped.push("quotes") },
      accountStream: { stop: () => stopped.push("account") },
    }
    ;(session as unknown as { current: unknown }).current = previous
    ;(session as unknown as { opened: { stop(): void }[] }).opened = [
      { stop: () => stopped.push("depth") },
      { stop: () => stopped.push("equity") },
    ]

    adopt(session)

    expect(stopped.sort()).toEqual(["account", "depth", "equity", "quotes"])
    // And the per-symbol streams are no longer tracked, so a later sign-out
    // does not stop them a second time.
    expect((session as unknown as { opened: unknown[] }).opened).toBeEmpty()
  })

  /**
   * A half-finished sign-in is stale the moment any session replaces it. Left
   * redeemable, a second terminal completing an older challenge would replace
   * the live session with one built from a login the trader had moved on from.
   */
  test("adopting a session closes a verification challenge still outstanding", () => {
    const session = new ProviderSession({ openAuthSession: sessionWith(null, { count: 0 }), credentials: null })
    let closed = 0
    ;(session as unknown as { pendingOtp: unknown }).pendingOtp = {
      client: {},
      close: () => (closed += 1),
    }

    adopt(session)

    expect(closed).toBe(1)
    expect((session as unknown as { pendingOtp: unknown }).pendingOtp).toBeNull()
    // And the challenge is gone, so completing it now is refused rather than
    // quietly taking over.
    expect(() => session.completeOtp("123456")).toThrow(/No sign-in is waiting/)
  })

  test("expiring twice still notifies, so a client that reconnects is told", async () => {
    const session = new ProviderSession({ openAuthSession: sessionWith(null, { count: 0 }), credentials: null })
    let expired = 0
    session.onExpired(() => (expired += 1))

    session.expire()
    session.expire()

    expect(expired).toBe(2)
  })
})
