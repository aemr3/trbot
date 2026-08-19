import { describe, expect, test } from "bun:test"
import { ChatGptAccountService } from "./chatgpt-account.ts"
import { createHarness } from "./harness.ts"
import type { ProviderState, ProviderStateStore } from "./provider-state.ts"

/**
 * What is left of this service after the harness took over the tokens: recording
 * a connection, reporting it, and forgetting it. Keeping a token usable is tested
 * one level down, in `credentials.test.ts`, against the store the harness writes
 * through.
 */
describe("ChatGPT account", () => {
  test("stores the credentials a login produced and removes them on disconnect", async () => {
    const store = memoryStore()
    const account = service(store)

    const saved = await account.save({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 601_000,
      accountId: "account-1",
    })

    expect(saved.providerId).toBe("openai-codex")
    expect(saved.accessToken).toBe("access-1")
    expect(saved.refreshToken).toBe("refresh-1")
    expect(saved.expiresAt).toBe(601_000)
    expect(saved.accountId).toBe("account-1")

    await account.disconnect()
    expect(await account.getState()).toBeNull()
  })

  test("reconnecting keeps the original connection date", async () => {
    // The date is what the modal shows as "connected since", so a re-login after an
    // expiry must not look like a new account.
    const store = memoryStore()
    const account = service(store)

    const first = await account.save({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })
    const second = await account.save({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-1",
    })

    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(second.accessToken).toBe("access-2")
  })

  test("reports whether anything is connected, asking the harness rather than a clock", async () => {
    // An expired token is not "not connected": the harness refreshes it as part of
    // the next request, so refusing on expiry would refuse a working connection.
    const store = memoryStore()
    const account = service(store)
    expect(await account.isConnected()).toBe(false)

    await account.save({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })
    expect(await account.isConnected()).toBe(true)

    await account.disconnect()
    expect(await account.isConnected()).toBe(false)
  })
})

function service(store: ProviderStateStore): ChatGptAccountService {
  return new ChatGptAccountService(store, createHarness(store))
}

function memoryStore(): ProviderStateStore {
  let state: ProviderState | null = null
  return {
    get: async (providerId) => (state?.providerId === providerId ? state : null),
    put: async (next) => {
      state = next
    },
    delete: async () => {
      state = null
    },
  }
}
