import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { createHarness } from "@trbot/ai/harness.ts"
import type { AiCredentialRecord, AiCredentialStore, AiPreferencesRecord, AiPreferencesStore } from "@trbot/ai/credential-store.ts"
import { HttpAiAccount } from "@trbot/client/ai.ts"
import { HttpChatSessions } from "@trbot/client/chat.ts"
import { HttpClient } from "@trbot/client/http.ts"
import type { ChatNotification, ChatNotificationStore } from "@trbot/chat/notification.ts"
import type { ChatSessionDetail } from "@trbot/chat/session.ts"
import { HttpInstrumentSource, HttpMemberFeatureSource, HttpOrderSource } from "@trbot/client/sources.ts"
import { memberFeatureSet, type MemberFeatureSet } from "@trbot/member/features.ts"
import { AiProviderSummarySchema, type AiPreferences } from "@trbot/protocol/ai.ts"
import { isProtocolError, requiresAuthentication, type ProtocolError } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import { DrizzleAppPreferencesStore } from "@trbot/db/app-preferences-store.ts"
import { AiService } from "../ai.ts"
import { IdempotencyStore } from "./idempotency.ts"
import { startServer } from "./server.ts"
import { serverDeps } from "./server.test-fixture.ts"
import { providerSources, TestProviderSession } from "../provider.test-fixture.ts"
import { ChatNotificationController } from "../chat-notification.ts"
import { StreamHub } from "../stream-hub.ts"
import type { SocketData } from "../stream-hub.ts"
import { z } from "zod"
import type { ChatController } from "../chat.ts"

const TOKEN = "integration-token"

function memoryCredentials(): AiCredentialStore {
  const records = new Map<string, AiCredentialRecord>()
  return {
    async get(providerId) {
      return records.get(providerId) ?? null
    },
    async list() {
      return [...records.values()]
    },
    async put(record) {
      records.set(record.providerId, record)
    },
    async delete(providerId) {
      records.delete(providerId)
    },
  }
}

function memoryPreferences(): AiPreferencesStore {
  let stored: AiPreferencesRecord | null = null
  return {
    async get() {
      return stored
    },
    async put(preferences) {
      stored = { ...preferences, updatedAt: Date.now() }
      return stored
    },
  }
}

describe("server and client over the wire", () => {
  let server: Server<SocketData>
  let client: HttpClient
  let url: string
  let connection: DatabaseConnection
  let session: TestProviderSession
  let notifications: ChatNotificationController
  const compactedChats: string[] = []
  const detailedChats: Array<{ sessionId: string; topLevelLimit?: number }> = []

  beforeAll(async () => {
    connection = await openDatabase(":memory:")
    session = new TestProviderSession()
    const hub = new StreamHub(session)
    const credentials = memoryCredentials()
    const ai = new AiService({
      models: createHarness(credentials),
      credentials,
      preferences: memoryPreferences(),
    })
    const notificationRows: ChatNotification[] = []
    const notificationStore: ChatNotificationStore = {
      list: async () => [...notificationRows],
      put: async (notification) => { notificationRows.push(notification) },
      remove: async (id) => {
        const index = notificationRows.findIndex((notification) => notification.id === id)
        if (index >= 0) notificationRows.splice(index, 1)
      },
    }
    notifications = new ChatNotificationController({ store: notificationStore, broadcast: () => {} })
    server = startServer(
      { host: "127.0.0.1", port: 0, token: TOKEN, tls: null },
      serverDeps({
        session,
        hub,
        idempotency: new IdempotencyStore(connection.db),
        preferences: new DrizzleAppPreferencesStore(connection.db),
        ai,
        // SAFETY: this integration suite exercises only these two controller surfaces.
        chat: {
          async detail(sessionId: string, topLevelLimit?: number): Promise<ChatSessionDetail> {
            detailedChats.push({ sessionId, topLevelLimit })
            return {
              session: {
                id: sessionId,
                title: "Test",
                parentSessionId: null,
                agent: null,
                provider: "test",
                model: "test",
                reasoning: null,
                createdAt: 1_000,
                updatedAt: 1_000,
                messageCount: 0,
                queued: 0,
                running: false,
              },
              messages: [],
              partial: null,
            }
          },
          async compact(sessionId: string) {
            compactedChats.push(sessionId)
            return { compacted: true, tokensBefore: 24_000 }
          },
        } as ChatController,
        notifications,
        backlog: () => [],
        onDecision: () => {},
      }),
    )
    url = `http://127.0.0.1:${server.port}`
    client = new HttpClient({ url, token: TOKEN })
  })

  afterAll(() => {
    void server.stop(true)
    connection.close()
  })

  test("health needs no token", async () => {
    const response = await fetch(`${url}${ROUTES.health}`)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("a wrong token is rejected with a protocol code", async () => {
    const wrong = new HttpClient({ url, token: "not-the-token" })
    const error = await wrong.get(ROUTES.session, z.unknown()).catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("unauthorized")
  })

  test("a signed-out server tells the client to sign in", async () => {
    const instruments = new HttpInstrumentSource(client)
    const error = await instruments.listInstruments().catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("unauthenticated")
    // This is the check the terminal uses to decide to show the login screen.
    expect(requiresAuthentication(error)).toBe(true)
  })

  test("an unknown route reports not_found rather than hanging", async () => {
    const error = await client.get("/v1/nope", z.unknown()).catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("not_found")
  })

  test("pending agent notifications round-trip and can be dismissed", async () => {
    const notification = await notifications.notify({
      sessionId: "chat-1",
      title: "Review complete",
      message: "The setup remains valid.",
      urgency: "INFO",
    })
    const chats = new HttpChatSessions(client)

    expect(await chats.notifications()).toEqual([notification])
    await chats.dismissNotification(notification.id)
    expect(await chats.notifications()).toEqual([])
  })

  test("manual chat compaction round-trips without exposing the hidden summary", async () => {
    compactedChats.length = 0
    const chats = new HttpChatSessions(client)

    expect(await chats.compact("chat/one")).toEqual({ compacted: true, tokensBefore: 24_000 })
    expect(compactedChats).toEqual(["chat/one"])
  })

  test("loads the bounded chat timeline over the wire", async () => {
    detailedChats.length = 0
    const chats = new HttpChatSessions(client)

    expect((await chats.get("chat/one")).session.id).toBe("chat/one")
    expect(detailedChats).toEqual([{ sessionId: "chat/one", topLevelLimit: 100 }])

    const error = await client
      .get(ROUTES.chatSession("chat/one"), z.unknown(), { query: { limit: "101" } })
      .catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("a rejected sign-in reports invalid_request for a missing field", async () => {
    const error = await client.post(ROUTES.login, z.unknown(), { body: { username: "someone" } }).catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("order routes reach the session check, so they are never silently accepted", async () => {
    const orders = new HttpOrderSource(client)
    const error = await orders
      .placeOrder({ instrumentUid: "x", side: "BUY", quantity: 1, limitPrice: 10 })
      .catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("unauthenticated")
  })

  test("an invalid order body is refused before any session work", async () => {
    const error = await client
      .post(ROUTES.placeOrder, z.unknown(), {
        body: { instrumentUid: "x", side: "SIDEWAYS", quantity: 1, limitPrice: 1 },
      })
      .catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("a feature set survives the wire with its behaviour intact", async () => {
    // A set that only answers `has` serializes to an empty object, so what the
    // client receives is rebuilt from the enabled list rather than parsed whole.
    const granted = memberFeatureSet(["MARKET_DEPTH", "SUBSCRIPTION"])
    const sources = { memberFeatures: { async loadFeatures(): Promise<MemberFeatureSet> { return granted } } }
    session.setSources(providerSources({ memberFeatures: sources.memberFeatures }))

    const features = await new HttpMemberFeatureSource(client).loadFeatures()

    expect(features.has("MARKET_DEPTH")).toBe(true)
    expect(features.has("SUBSCRIPTION")).toBe(true)
    expect(features.has("SETTLEMENT_ANALYSIS")).toBe(false)
    session.setSources(null)
  })

  // Guessing a six-digit code is cheap; guessing a password is not. The plan
  // said every sign-in route is throttled, and this is the one that matters.
  test("repeated verification-code attempts are refused", async () => {
    const attempt = async (): Promise<ProtocolError> => {
      try {
        await client.post(ROUTES.otp, z.unknown(), { body: { code: "000000" } })
        throw new Error("Expected verification to fail")
      } catch (cause) {
        if (isProtocolError(cause)) return cause
        throw cause
      }
    }

    for (let index = 0; index < 5; index += 1) {
      const error = await attempt()
      expect(isProtocolError(error) && error.message).toContain("No sign-in is waiting")
    }

    const refused = await attempt()
    expect(isProtocolError(refused) && refused.message).toContain("Too many attempts")
  })

  test("takes on a credential the terminal logged in and never hands one back", async () => {
    const account = new HttpAiAccount(client)
    const before = await account.providers()
    // Every provider the harness ships with is offered, not a chosen one.
    expect(before.length).toBeGreaterThan(10)
    expect(before.every((provider) => !provider.connected)).toBe(true)

    // The login itself runs on the trader's machine, because a provider only
    // redirects to localhost, it is their browser that has to open, and an API key is
    // theirs to type. What crosses the wire is the result, inward — the same
    // direction as the provider password.
    const summary = await client.post(ROUTES.aiProvider("groq"), AiProviderSummarySchema, {
      body: { providerId: "groq", credential: { type: "api_key", key: "gsk-not-a-real-key" } },
    })

    expect(summary).toMatchObject({ providerId: "groq", connected: true })
    // Nothing hands a credential back out, which is the half of the rule that still
    // holds absolutely.
    expect(JSON.stringify(summary)).not.toContain("gsk-not-a-real-key")

    const models = await account.models()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.providerId === "groq")).toBe(true)
    // The levels are resolved server-side, so a picker never works them out itself.
    expect(models.every((model) => model.thinkingLevels.length > 0)).toBe(true)

    await account.disconnect("groq")
    expect((await account.providers()).every((provider) => !provider.connected)).toBe(true)
  })

  test("a credential of no known kind is refused rather than stored", async () => {
    const error = await client
      .post(ROUTES.aiProvider("groq"), z.unknown(), {
        body: { providerId: "groq", credential: { key: "no-type" } },
      })
      .catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("the chosen models round-trip, and clearing one is a real answer", async () => {
    const account = new HttpAiAccount(client)
    expect(await account.preferences()).toEqual({ chat: null })

    const saved = await account.setPreferences({
      chat: { providerId: "groq", modelId: "llama-4", reasoning: "high" },
    })
    expect(saved).toEqual({ chat: { providerId: "groq", modelId: "llama-4", reasoning: "high" } })
    expect(await account.preferences()).toEqual(saved)

    const cleared: AiPreferences = { chat: null }
    expect(await account.setPreferences(cleared)).toEqual(cleared)
  })

  // The preferences store falls back to defaults for anything it does not
  // recognise on read, so an unchecked write would not fail — it would quietly
  // reset the trader's layout on next launch.
  test("malformed preferences are refused rather than silently reset later", async () => {
    // Complete but for the one bad field, so the failure names that field and
    // not merely the first thing missing.
    const preferences = {
      instrumentSort: "sideways",
      sortDirection: "desc",
      candleRange: "INTRADAY",
      candleInterval: "MIN_5",
      chartTarget: "UNDERLYING",
      chartIndicators: [],
      selectedInstrumentUid: null,
      orderKind: "LIMIT",
    }
    const error = await client
      .put(ROUTES.appPreferences, z.unknown(), { body: preferences })
      .catch((cause: unknown) => cause)

    expect(isProtocolError(error) && error.code).toBe("invalid_request")
    expect(isProtocolError(error) && error.message).toContain("instrumentSort")
  })

  test("an unreachable server surfaces as a transient error", async () => {
    const offline = new HttpClient({ url: "http://127.0.0.1:1", token: TOKEN })
    const error = await offline.get(ROUTES.session, z.unknown()).catch((cause: unknown) => cause)
    expect(isProtocolError(error) && error.code).toBe("upstream_unavailable")
  })
})
