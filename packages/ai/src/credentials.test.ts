import { describe, expect, test } from "bun:test"
import type { AiCredentialRecord, AiCredentialStore } from "./credential-store.ts"
import { StoredCredentials } from "./credentials.ts"

/**
 * The one part of credential handling that stays ours: where a credential lives.
 * The harness reads and writes through this, so a mistake here is a trader asked
 * to log in again — or worse, a rotated refresh token lost.
 */
describe("the stored credential", () => {
  test("reads the connection the harness asks for", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.read(PROVIDER)).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 601_000,
      accountId: "account-1",
    })
  })

  test("lists the connection under the id the harness asked about", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.list()).toEqual([{ providerId: PROVIDER, type: "oauth" }])
  })

  test("knows nothing about a provider nothing is stored for", async () => {
    const credentials = new StoredCredentials(memoryStore(connection()))

    expect(await credentials.read("anthropic")).toBeUndefined()
    expect(await credentials.read(PROVIDER)).not.toBeUndefined()
  })

  test("writes a refreshed credential and keeps the connection date", async () => {
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store, { now: () => 5_000 })

    const written = await credentials.modify(PROVIDER, async (current) => ({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: 1_200_000,
      accountId: (current as { accountId?: string } | undefined)?.accountId ?? null,
    }))

    expect((written as { access: string }).access).toBe("access-2")
    const stored = await credentialIn(store)
    expect(stored?.access).toBe("access-2")
    expect(stored?.refresh).toBe("refresh-2")
    expect((await store.get(PROVIDER))?.createdAt).toBe(1_000)
    expect((await store.get(PROVIDER))?.updatedAt).toBe(5_000)
  })

  test("serializes writes, so two refreshes cannot lose a rotated token", async () => {
    // The harness rotates the refresh token on every exchange. Two overlapping
    // read-modify-writes would let the second overwrite from a stale read, leaving
    // a token the provider has already invalidated.
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)
    const order: string[] = []

    const rotate = (name: string) =>
      credentials.modify(PROVIDER, async (current) => {
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
    expect((await credentialIn(store))?.refresh).toBe("refresh-1+first+second")
  })

  test("leaves the stored credential alone when a refresh declines to replace it", async () => {
    // The harness returns undefined to mean "nothing to change". Treating that as
    // "delete" would sign a trader out because a token happened to still be valid.
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)

    const kept = await credentials.modify(PROVIDER, async () => undefined)

    expect((kept as { access: string }).access).toBe("access-1")
    expect((await credentialIn(store))?.access).toBe("access-1")
  })

  test("a failed write does not block the next one", async () => {
    const store = memoryStore(connection())
    const credentials = new StoredCredentials(store)

    await credentials
      .modify(PROVIDER, () => Promise.reject(new Error("the exchange failed")))
      .catch(() => undefined)

    const after = await credentials.modify(PROVIDER, async () => ({
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

    await credentials.delete(PROVIDER)

    expect(await credentials.read(PROVIDER)).toBeUndefined()
    expect(await credentials.list()).toEqual([])
  })

  test("reports a connection with no account id without inventing one", async () => {
    const credentials = new StoredCredentials(memoryStore({ ...connection(), credential: { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 601_000 } }))

    expect(await credentials.read(PROVIDER)).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 601_000,
    })
  })
})

/** A provider that authenticates with a subscription grant. */
const PROVIDER = "openai-codex"

function connection(): AiCredentialRecord {
  return {
    providerId: PROVIDER,
    credential: {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 601_000,
      accountId: "account-1",
    },
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

/** What is actually written, read straight back off the record. */
async function credentialIn(store: AiCredentialStore): Promise<{ access: string; refresh: string } | null> {
  const record = await store.get(PROVIDER)
  return record ? (record.credential as { access: string; refresh: string }) : null
}

function memoryStore(...initial: AiCredentialRecord[]): AiCredentialStore {
  const records = new Map(initial.map((record) => [record.providerId, record]))
  return {
    get: async (providerId) => records.get(providerId) ?? null,
    list: async () => [...records.values()],
    put: async (record) => {
      records.set(record.providerId, record)
    },
    delete: async (providerId) => {
      records.delete(providerId)
    },
  }
}
