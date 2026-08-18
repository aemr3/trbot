import { describe, expect, test } from "bun:test"
import type { ChatGptOAuth, ChatGptTokenResponse } from "./chatgpt-oauth.ts"
import { ChatGptAccountService } from "./chatgpt-account.ts"
import type { ProviderState, ProviderStateStore } from "./provider-state.ts"

describe("ChatGPT account", () => {
  test("persists exchanged tokens and removes them on disconnect", async () => {
    const store = memoryStore()
    const account = new ChatGptAccountService(store, { now: () => 1_000, oauth: oauth() })

    const saved = await account.save({
      idToken: jwt({ chatgpt_account_id: "account-1", email: "trader@example.com" }),
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 600,
    })

    expect(saved).toEqual({
      providerId: "openai",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 601_000,
      accountId: "account-1",
      email: "trader@example.com",
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await account.disconnect()
    expect(await account.getState()).toBeNull()
  })

  test("refreshes an expiring session once for concurrent callers", async () => {
    const store = memoryStore({
      providerId: "openai",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: 1_500,
      accountId: "account-1",
      email: null,
      createdAt: 100,
      updatedAt: 100,
    })
    let refreshes = 0
    const account = new ChatGptAccountService(store, {
      now: () => 1_000,
      oauth: oauth({
        async refresh() {
          refreshes += 1
          await Promise.resolve()
          return { idToken: null, accessToken: "access-new", refreshToken: "refresh-new", expiresIn: 600 }
        },
      }),
    })

    const [first, second] = await Promise.all([account.validState(), account.validState()])
    expect(refreshes).toBe(1)
    expect(first.accessToken).toBe("access-new")
    expect(second).toEqual(first)
  })

  test("reports a missing connection rather than returning an unusable state", async () => {
    const account = new ChatGptAccountService(memoryStore(), { oauth: oauth() })
    const failure = await account.validState().then(
      () => new Error("expected a failure"),
      (error: unknown) => error as Error,
    )
    expect(failure.message).toBe("ChatGPT is not connected")
  })
})

function memoryStore(initial: ProviderState | null = null): ProviderStateStore {
  let state = initial
  return {
    async get(providerId) {
      return state?.providerId === providerId ? state : null
    },
    async put(value) {
      state = value
    },
    async delete(providerId) {
      if (state?.providerId === providerId) state = null
    },
  }
}

function oauth(overrides: Partial<ChatGptOAuth> = {}): ChatGptOAuth {
  const unused = (): never => {
    throw new Error("not used")
  }
  return {
    authorize: overrides.authorize ?? unused,
    exchange: overrides.exchange ?? unused,
    refresh: overrides.refresh ?? (unused as () => Promise<ChatGptTokenResponse>),
  }
}

function jwt(payload: object): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}
