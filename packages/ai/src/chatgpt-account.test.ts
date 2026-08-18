import { describe, expect, test } from "bun:test"
import { ChatGptAccountService, type ChatGptTokenRefresh } from "./chatgpt-account.ts"
import type { ProviderState, ProviderStateStore } from "./provider-state.ts"

describe("ChatGPT account", () => {
  test("stores the credentials a login produced and removes them on disconnect", async () => {
    const store = memoryStore()
    const account = new ChatGptAccountService(store, { now: () => 1_000, tokens: refresher() })

    const saved = await account.save({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 601_000,
      accountId: "account-1",
    })

    expect(saved).toEqual({
      providerId: "openai",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 601_000,
      accountId: "account-1",
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await account.disconnect()
    expect(await account.getState()).toBeNull()
  })

  test("reconnecting keeps the original connection date", async () => {
    const store = memoryStore(state({ createdAt: 100, updatedAt: 100 }))
    const account = new ChatGptAccountService(store, { now: () => 5_000, tokens: refresher() })

    const saved = await account.save({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 900_000,
      accountId: "account-1",
    })

    expect(saved.createdAt).toBe(100)
    expect(saved.updatedAt).toBe(5_000)
  })

  test("refreshes an expiring session once for concurrent callers", async () => {
    const store = memoryStore(state({ expiresAt: 1_500 }))
    let refreshes = 0
    const account = new ChatGptAccountService(store, {
      now: () => 1_000,
      tokens: refresher(async () => {
        refreshes += 1
        await Promise.resolve()
        return {
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAt: 601_000,
          accountId: "account-1",
        }
      }),
    })

    const [first, second] = await Promise.all([account.validState(), account.validState()])
    expect(refreshes).toBe(1)
    expect(first?.accessToken).toBe("access-new")
    expect(second).toEqual(first)
  })

  test("a refresh that reports no account keeps the one already stored", async () => {
    // The harness reads the account id out of the token it was handed; a build
    // that stops reporting one must not blank a working connection.
    const store = memoryStore(state({ expiresAt: 1_500, accountId: "account-1" }))
    const account = new ChatGptAccountService(store, {
      now: () => 1_000,
      tokens: refresher(async () => ({
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresAt: 601_000,
        accountId: null,
      })),
    })

    expect((await account.validState()).accountId).toBe("account-1")
  })

  test("reports a missing connection rather than returning an unusable state", async () => {
    const account = new ChatGptAccountService(memoryStore(), { tokens: refresher() })
    const failure = await account.validState().then(
      () => new Error("expected a failure"),
      (error: unknown) => error as Error,
    )
    expect(failure.message).toBe("ChatGPT is not connected")
  })
})

function state(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    providerId: "openai",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 1_500,
    accountId: "account-1",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function memoryStore(initial: ProviderState | null = null): ProviderStateStore {
  let stored = initial
  return {
    async get(providerId) {
      return stored?.providerId === providerId ? stored : null
    },
    async put(value) {
      stored = value
    },
    async delete(providerId) {
      if (stored?.providerId === providerId) stored = null
    },
  }
}

function refresher(refresh?: ChatGptTokenRefresh["refresh"]): ChatGptTokenRefresh {
  return {
    refresh: refresh ?? (() => {
      throw new Error("not used")
    }),
  }
}
