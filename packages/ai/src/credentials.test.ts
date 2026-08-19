import { describe, expect, test } from "bun:test"
import { StoredCredentials } from "./credentials.ts"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

/**
 * The one part of credential handling that stays ours: where a credential lives.
 * The harness reads and writes through this, so a mistake here is a trader asked
 * to log in again — or worse, a rotated refresh token lost.
 */
describe("the stored credential", () => {
  test("reads the connection the harness asks for", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.read(CHATGPT_PROVIDER_ID)).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 601_000,
      accountId: "account-1",
    })
  })

  test("lists the connection under the id the harness asked about", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.list()).toEqual([{ providerId: CHATGPT_PROVIDER_ID, type: "oauth" }])
  })

  test("knows nothing about a provider nothing is stored for", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.read("anthropic")).toBeUndefined()
    expect(await credentials.read(CHATGPT_PROVIDER_ID)).not.toBeUndefined()
  })

  test("writes a refreshed credential and keeps the connection date", async () => {
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store, { now: () => 5_000 })

    const written = await credentials.modify(CHATGPT_PROVIDER_ID, async (current) => ({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: 1_200_000,
      accountId: (current as { accountId?: string } | undefined)?.accountId ?? null,
    }))

    expect((written as { access: string }).access).toBe("access-2")
    const state = await store.get(CHATGPT_PROVIDER_ID)
    expect(state?.accessToken).toBe("access-2")
    expect(state?.refreshToken).toBe("refresh-2")
    expect(state?.createdAt).toBe(1_000)
    expect(state?.updatedAt).toBe(5_000)
  })

  test("serializes writes, so two refreshes cannot lose a rotated token", async () => {
    // The harness rotates the refresh token on every exchange. Two overlapping
    // read-modify-writes would let the second overwrite from a stale read, leaving
    // a token the provider has already invalidated.
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)
    const order: string[] = []

    const rotate = (name: string) =>
      credentials.modify(CHATGPT_PROVIDER_ID, async (current) => {
        order.push(`${name}:read`)
        const previous = (current as { refresh: string }).refresh
        await Bun.sleep(5)
        order.push(`${name}:write`)
        return { type: "oauth", access: "a", refresh: `${previous}+${name}`, expires: 1 }
      })

    await Promise.all([rotate("first"), rotate("second")])

    // Interleaved reads would show read, read, write, write.
    expect(order).toEqual(["first:read", "first:write", "second:read", "second:write"])
    // Each rotation saw the one before it, so nothing was overwritten blind.
    expect((await store.get(CHATGPT_PROVIDER_ID))?.refreshToken).toBe("refresh-1+first+second")
  })

  test("leaves the stored credential alone when a refresh declines to replace it", async () => {
    // The harness returns undefined to mean "nothing to change". Treating that as
    // "delete" would sign a trader out because a token happened to still be valid.
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)

    const kept = await credentials.modify(CHATGPT_PROVIDER_ID, async () => undefined)

    expect((kept as { access: string }).access).toBe("access-1")
    expect((await store.get(CHATGPT_PROVIDER_ID))?.accessToken).toBe("access-1")
  })

  test("a failed write does not block the next one", async () => {
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)

    await credentials
      .modify(CHATGPT_PROVIDER_ID, () => Promise.reject(new Error("the exchange failed")))
      .catch(() => undefined)

    const after = await credentials.modify(CHATGPT_PROVIDER_ID, async () => ({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: 2,
    }))
    expect((after as { access: string }).access).toBe("access-2")
  })

  test("forgets the connection on logout", async () => {
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)

    await credentials.delete(CHATGPT_PROVIDER_ID)

    expect(await credentials.read(CHATGPT_PROVIDER_ID)).toBeUndefined()
    expect(await credentials.list()).toEqual([])
  })

  test("reports a connection with no account id without inventing one", async () => {
    const credentials = new StoredCredentials(memoryStore({ ...connection(), accountId: null }))

    expect(await credentials.read(CHATGPT_PROVIDER_ID)).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 601_000,
    })
  })
})

function connection(): ProviderState {
  return {
    providerId: CHATGPT_PROVIDER_ID,
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 601_000,
    accountId: "account-1",
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function memoryStore(initial: ProviderState | null = null): ProviderStateStore {
  let state = initial
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
