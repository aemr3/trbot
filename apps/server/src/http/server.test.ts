import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import type { AuthSession } from "@trbot/auth/session.ts"
import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import { createHarness } from "@trbot/ai/harness.ts"
import type { AiCredentialRecord, AiCredentialStore, AiPreferencesRecord, AiPreferencesStore } from "@trbot/ai/credential-store.ts"
import { HttpAiAccount, HttpOverviewGenerator } from "@trbot/client/ai.ts"
import { HttpClient } from "@trbot/client/http.ts"
import { HttpInstrumentSource, HttpMemberFeatureSource, HttpOrderSource } from "@trbot/client/sources.ts"
import { buildOverviewDigest, type MarketOverviewDigest } from "@trbot/market/overview.ts"
import { memberFeatureSet, type MemberFeatureSet } from "@trbot/member/features.ts"
import { AiProviderSummarySchema, type AiPreferences } from "@trbot/protocol/ai.ts"
import { isProtocolError, requiresAuthentication } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import { AiService } from "../ai.ts"
import { IdempotencyStore } from "./idempotency.ts"
import { startServer } from "./server.ts"
import { ProviderSession } from "../session.ts"
import { StreamHub } from "../stream-hub.ts"
import type { SocketData } from "../stream-hub.ts"
import { z } from "zod"

const TOKEN = "integration-token"

/** An auth store with nothing in it, so the session resumes to "signed out". */
function emptyAuthSession(): Promise<AuthSession> {
  const store: AuthStore = {
    async get(): Promise<AuthState | null> {
      return null
    },
    async latest(): Promise<AuthState | null> {
      return null
    },
    async put(): Promise<void> {},
  }
  return Promise.resolve({ store, close() {} })
}

const notUsed = new Proxy({}, { get: () => () => { throw new Error("not used in this test") } })

const DIGEST = buildOverviewDigest({
  mode: "DAILY",
  instrument: {
    symbol: "ASELS",
    displayName: "Aselsan",
    lastPrice: 390,
    contractSymbol: "F_ASELS0826",
    contractLastPrice: 394,
  },
  range: { start: null, end: null },
})

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
  let session: ProviderSession
  let overviewFailure: Error | null = null

  beforeAll(async () => {
    connection = await openDatabase(":memory:")
    session = new ProviderSession({ openAuthSession: emptyAuthSession, credentials: null })
    const hub = new StreamHub(session)
    const credentials = memoryCredentials()
    const ai = new AiService({
      models: createHarness(credentials),
      credentials,
      preferences: memoryPreferences(),
      generator: {
        async generate(_digest, options) {
          options.onDelta("Flow is ")
          if (overviewFailure) throw overviewFailure
          options.onDelta("one-sided.")
        },
      },
    })
    server = startServer(
      { host: "127.0.0.1", port: 0, token: TOKEN, tls: null },
      {
        session,
        hub,
        idempotency: new IdempotencyStore(connection.db),
        preferences: notUsed as never,
        alerts: notUsed as never,
        stops: notUsed as never,
        overviewSnapshots: notUsed as never,
        ai,
        chat: notUsed as never,
        questions: notUsed as never,
        backlog: () => [],
        onDecision: () => {},
      },
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
    const error = await wrong.get(ROUTES.session, z.unknown()).catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("unauthorized")
  })

  test("a signed-out server tells the client to sign in", async () => {
    const instruments = new HttpInstrumentSource(client)
    const error = await instruments.listInstruments().catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("unauthenticated")
    // This is the check the terminal uses to decide to show the login screen.
    expect(requiresAuthentication(error)).toBe(true)
  })

  test("an unknown route reports not_found rather than hanging", async () => {
    const error = await client.get("/v1/nope", z.unknown()).catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("not_found")
  })

  test("a rejected sign-in reports invalid_request for a missing field", async () => {
    const error = await client.post(ROUTES.login, z.unknown(), { body: { username: "someone" } }).catch((c: unknown) => c)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("order routes reach the session check, so they are never silently accepted", async () => {
    const orders = new HttpOrderSource(client)
    const error = await orders
      .placeOrder({ instrumentUid: "x", side: "BUY", quantity: 1, limitPrice: 10 })
      .catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("unauthenticated")
  })

  test("an invalid order body is refused before any session work", async () => {
    const error = await client
      .post(ROUTES.placeOrder, z.unknown(), {
        body: { instrumentUid: "x", side: "SIDEWAYS", quantity: 1, limitPrice: 1 },
      })
      .catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("a feature set survives the wire with its behaviour intact", async () => {
    // A set that only answers `has` serializes to an empty object, so what the
    // client receives is rebuilt from the enabled list rather than parsed whole.
    const granted = memberFeatureSet(["MARKET_DEPTH", "SUBSCRIPTION"])
    const sources = { memberFeatures: { async loadFeatures(): Promise<MemberFeatureSet> { return granted } } }
    ;(session as unknown as { current: unknown }).current = sources

    const features = await new HttpMemberFeatureSource(client).loadFeatures()

    expect(typeof features.has).toBe("function")
    expect(features.has("MARKET_DEPTH")).toBe(true)
    expect(features.has("SUBSCRIPTION")).toBe(true)
    expect(features.has("SETTLEMENT_ANALYSIS")).toBe(false)
    ;(session as unknown as { current: unknown }).current = null
  })

  // Guessing a six-digit code is cheap; guessing a password is not. The plan
  // said every sign-in route is throttled, and this is the one that matters.
  test("repeated verification-code attempts are refused", async () => {
    const attempt = (): Promise<unknown> =>
      client.post(ROUTES.otp, z.unknown(), { body: { code: "000000" } }).catch((caught: unknown) => caught)

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
      .catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("the chosen models round-trip, and clearing one is a real answer", async () => {
    const account = new HttpAiAccount(client)
    expect(await account.preferences()).toEqual({ overview: null, chat: null })

    const saved = await account.setPreferences({
      overview: { providerId: "groq", modelId: "llama-4", reasoning: "high" },
      chat: null,
    })
    expect(saved).toEqual({ overview: { providerId: "groq", modelId: "llama-4", reasoning: "high" }, chat: null })
    expect(await account.preferences()).toEqual(saved)

    const cleared: AiPreferences = { overview: null, chat: null }
    expect(await account.setPreferences(cleared)).toEqual(cleared)
  })

  // Every stream opens with a heartbeat, so this also proves the client passes
  // only real commentary to the panel and never renders a keep-alive frame.
  //
  // A model has to be chosen and reachable first, because that is what the route
  // checks before it opens a stream at all.
  test("the overview streams from the server a piece at a time", async () => {
    const account = new HttpAiAccount(client)
    await client.post(ROUTES.aiProvider("groq"), AiProviderSummarySchema, {
      body: { providerId: "groq", credential: { type: "api_key", key: "gsk-not-a-real-key" } },
    })
    await account.setPreferences({
      overview: { providerId: "groq", modelId: "llama-4", reasoning: null },
      chat: null,
    })

    const deltas: string[] = []
    await new HttpOverviewGenerator(client).generate(DIGEST, { onDelta: (text) => deltas.push(text) })
    expect(deltas).toEqual(["Flow is ", "one-sided."])
  })


  // The status is long gone by the time the model fails, so the failure has to
  // travel as a frame. What the client rethrows is still a protocol error.
  test("a failure part way through the overview reaches the client", async () => {
    overviewFailure = new Error("the model gave up")
    const deltas: string[] = []
    const error = await new HttpOverviewGenerator(client)
      .generate(DIGEST, { onDelta: (text) => deltas.push(text) })
      .catch((caught: unknown) => caught)

    expect(deltas).toEqual(["Flow is "])
    expect(isProtocolError(error) && error.message).toContain("the model gave up")
    overviewFailure = null
  })

  test("an overview for an unknown mode is refused before anything streams", async () => {
    const error = await new HttpOverviewGenerator(client)
      .generate({ mode: "HOURLY" } as unknown as MarketOverviewDigest, { onDelta: () => {} })
      .catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  /**
   * Two ways an overview has nowhere to come from, and both are refused before a
   * stream opens rather than reported inside one. They read differently on purpose:
   * one is fixed by picking a model, the other by reconnecting a provider.
   */
  test("the overview is refused outright when it has no model to run on", async () => {
    const account = new HttpAiAccount(client)

    await account.setPreferences({ overview: null, chat: null })
    const unchosen = await new HttpOverviewGenerator(client)
      .generate(DIGEST, { onDelta: () => {} })
      .catch((caught: unknown) => caught)
    expect(isProtocolError(unchosen) && unchosen.code).toBe("invalid_request")
    expect(isProtocolError(unchosen) && unchosen.message).toContain("No model chosen")

    // Chosen, but its provider has been disconnected since.
    await account.setPreferences({
      overview: { providerId: "groq", modelId: "llama-4", reasoning: null },
      chat: null,
    })
    await account.disconnect("groq")
    const gone = await new HttpOverviewGenerator(client)
      .generate(DIGEST, { onDelta: () => {} })
      .catch((caught: unknown) => caught)
    expect(isProtocolError(gone) && gone.code).toBe("invalid_request")
    expect(isProtocolError(gone) && gone.message).toContain("not connected")
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
      .catch((caught: unknown) => caught)

    expect(isProtocolError(error) && error.code).toBe("invalid_request")
    expect(isProtocolError(error) && error.message).toContain("instrumentSort")
  })

  test("an overview snapshot without the fields it is stored under is refused", async () => {
    const error = await client
      .put(ROUTES.overviewSnapshots, z.unknown(), { body: { commentary: "words", digest: {} } })
      .catch((caught: unknown) => caught)

    expect(isProtocolError(error) && error.code).toBe("invalid_request")
  })

  test("an unreachable server surfaces as a transient error", async () => {
    const offline = new HttpClient({ url: "http://127.0.0.1:1", token: TOKEN })
    const error = await offline.get(ROUTES.session, z.unknown()).catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("upstream_unavailable")
  })
})
