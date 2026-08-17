import { afterEach, describe, expect, test } from "bun:test"
import type { AuthState } from "@trbot/auth/state.ts"
import { DrizzleAuthStore } from "./auth-store.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"

describe("database auth store", () => {
  let connection: DatabaseConnection | null = null

  afterEach(() => {
    connection?.close()
    connection = null
  })

  test("persists and atomically replaces authentication state", async () => {
    connection = await openDatabase(":memory:")
    const store = new DrizzleAuthStore(connection.db)
    const initial = state()

    await store.put(initial)
    expect(await store.get(initial.accountKey)).toEqual(initial)
    expect(await store.latest()).toEqual(initial)

    await store.put({
      ...initial,
      accessToken: "access-new",
      refreshToken: "refresh-new",
      updatedAt: initial.updatedAt + 1,
    })
    const updated = await store.get(initial.accountKey)
    expect(updated?.accessToken).toBe("access-new")
    expect(updated?.refreshToken).toBe("refresh-new")
    expect(updated?.createdAt).toBe(initial.createdAt)
  })
})

function state(): AuthState {
  return {
    accountKey: "account-key",
    memberUid: "member-1",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accessTokenExpiresAt: 1_786_000_600_000,
    deviceId: "device-1",
    userAgentUid: "agent-1",
    privateKeyPem: "private-key",
    publicKeyBase64: "public-key",
    loginReferenceCode: null,
    createdAt: 1_786_000_000_000,
    updatedAt: 1_786_000_000_000,
  }
}
