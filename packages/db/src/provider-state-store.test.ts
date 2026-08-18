import { afterEach, describe, expect, test } from "bun:test"
import type { ProviderState } from "@trbot/ai/provider-state.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleProviderStateStore } from "./provider-state-store.ts"

describe("provider state store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("persists, updates, and deletes provider sessions", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleProviderStateStore(connection.db)
    const initial = state()

    expect(await store.get(initial.providerId)).toBeNull()
    await store.put(initial)
    expect(await store.get(initial.providerId)).toEqual(initial)

    await store.put({
      ...initial,
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: initial.expiresAt + 1_000,
      updatedAt: initial.updatedAt + 1_000,
    })
    expect(await store.get(initial.providerId)).toEqual({
      ...initial,
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: initial.expiresAt + 1_000,
      updatedAt: initial.updatedAt + 1_000,
    })

    await store.delete(initial.providerId)
    expect(await store.get(initial.providerId)).toBeNull()
  })
})

function state(): ProviderState {
  return {
    providerId: "openai",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 1_786_000_600_000,
    accountId: "account-1",
    createdAt: 1_786_000_000_000,
    updatedAt: 1_786_000_000_000,
  }
}
