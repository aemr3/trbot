import { describe, expect, test } from "bun:test"
import { fauxProvider } from "@earendil-works/pi-ai"
import { AiConnections } from "./connections.ts"
import type {
  AiCredentialRecord,
  AiCredentialStore,
  AiModelChoice,
  AiPreferencesRecord,
  AiPreferencesStore,
} from "./credential-store.ts"
import { createHarness, harnessModel } from "./harness.ts"

/**
 * What a trader can use, and what happens when they connect something.
 *
 * These run against the real harness rather than a stand-in, because the whole point
 * of the change is that trbot no longer has its own idea of which providers or models
 * exist — so a test with its own idea would prove nothing.
 */
describe("model providers", () => {
  test("offers every provider the harness ships with, connected or not", async () => {
    const connections = build()
    const providers = await connections.providers()

    // The exact number moves with harness releases; that there are many, and that
    // trbot did not pick them, is the point.
    expect(providers.length).toBeGreaterThan(30)
    expect(providers.every((provider) => provider.authTypes.length > 0)).toBe(true)
    expect(providers.some((provider) => provider.isSubscription)).toBe(true)
    expect(providers.some((provider) => provider.authTypes.includes("api_key"))).toBe(true)
    expect(providers.every((provider) => !provider.connected)).toBe(true)
  })

  test("nothing is usable until something is connected", async () => {
    const connections = build()
    expect(await connections.models()).toEqual([])
  })

  test("forces dynamic provider refresh before returning a requested fresh list", async () => {
    const credentials = memoryCredentials()
    const harness = createTestHarness(credentials)
    const faux = fauxProvider({ provider: "dynamic", models: [{ id: "dynamic-model" }] })
    let networkRefreshes = 0
    let forced = false
    harness.setProvider({
      ...faux.provider,
      refreshModels: async (context) => {
        if (!context.allowNetwork) return
        networkRefreshes += 1
        forced = context.force === true
      },
    })
    const connections = new AiConnections(harness, credentials, memoryPreferences())

    await connections.models()
    expect(networkRefreshes).toBe(0)

    const models = await connections.models({ refresh: true })
    expect(networkRefreshes).toBe(1)
    expect(forced).toBe(true)
    expect(models.some((model) => model.providerId === "dynamic")).toBe(true)
  })

  test("connecting an API key makes that provider's models usable", async () => {
    const connections = build()
    await connections.connect("groq", { type: "api_key", key: "gsk-not-a-real-key" })

    expect(await connections.isConnected("groq")).toBe(true)
    const models = await connections.models()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.providerId === "groq")).toBe(true)
    // The reasoning levels come from each model rather than a list of our own, so a
    // picker cannot offer a level the provider would refuse.
    expect(models.every((model) => model.thinkingLevels.length > 0)).toBe(true)

    const summary = (await connections.providers()).find((provider) => provider.providerId === "groq")
    expect(summary?.connected).toBe(true)
    expect(summary?.source).toBeTruthy()
  })

  test("two providers can be connected at once", async () => {
    // A trader with a subscription and an API key uses both, and picks per session.
    const connections = build()
    await connections.connect("groq", { type: "api_key", key: "gsk-not-a-real-key" })
    await connections.connect("openai-codex", {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 3_600_000,
      accountId: "account-1",
    })

    const connected = (await connections.providers()).filter((provider) => provider.connected)
    expect(connected.map((provider) => provider.providerId).sort()).toEqual(["groq", "openai-codex"])

    const providers = new Set((await connections.models()).map((model) => model.providerId))
    expect(providers).toEqual(new Set(["groq", "openai-codex"]))
  })

  test("disconnecting one leaves the other alone", async () => {
    const connections = build()
    await connections.connect("groq", { type: "api_key", key: "gsk-not-a-real-key" })
    await connections.connect("cerebras", { type: "api_key", key: "csk-not-a-real-key" })

    await connections.disconnect("groq")

    expect(await connections.isConnected("groq")).toBe(false)
    expect(await connections.isConnected("cerebras")).toBe(true)
  })

  test("an account id the harness recorded is reported back, and a secret never is", async () => {
    const connections = build()
    await connections.connect("openai-codex", {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 3_600_000,
      accountId: "account-1",
    })

    const summary = (await connections.providers()).find((provider) => provider.providerId === "openai-codex")
    expect(summary?.accountId).toBe("account-1")
    expect(JSON.stringify(summary)).not.toContain("access-1")
    expect(JSON.stringify(summary)).not.toContain("refresh-1")
  })

  test("refuses a credential of no known kind, and a provider it does not have", async () => {
    const connections = build()
    await expect(connections.connect("groq", { key: "no-kind" })).rejects.toThrow("credential")
    await expect(connections.connect("not-a-provider", { type: "api_key", key: "k" })).rejects.toThrow("No provider")
  })

  test("the chosen models round-trip, including clearing one", async () => {
    const connections = build()
    expect(await connections.preferences()).toEqual({ chat: null })

    const choice: AiModelChoice = { providerId: "groq", modelId: "llama-4", reasoning: "high" }
    await connections.setPreferences({ chat: choice })
    expect(await connections.preferences()).toEqual({ chat: choice })

    await connections.setPreferences({ chat: null })
    expect(await connections.preferences()).toEqual({ chat: null })
  })
})

describe("resolving a chosen model", () => {
  test("finds a model the catalogue has", () => {
    const models = createTestHarness(memoryCredentials())
    const first = models.getModels("groq")[0]
    if (!first) throw new Error("the harness reported no Groq models")

    expect(harnessModel(models, "groq", first.id).id).toBe(first.id)
  })

  test("refuses a model that is gone, naming ones that are not", () => {
    // A provider retires a model, or an upgrade drops it. Guessing a replacement
    // would answer a trader from a model they never picked.
    const models = createTestHarness(memoryCredentials())
    const failure = attempt(() => harnessModel(models, "groq", "llama-1-does-not-exist"))

    expect(failure?.message).toContain("llama-1-does-not-exist")
    expect(failure?.message).toContain("It offers:")
  })

  test("refuses a provider the harness does not have at all", () => {
    const models = createTestHarness(memoryCredentials())
    expect(attempt(() => harnessModel(models, "not-a-provider", "any"))?.message).toContain("reconnect")
  })
})

function build(): AiConnections {
  const credentials = memoryCredentials()
  return new AiConnections(createTestHarness(credentials), credentials, memoryPreferences())
}

function createTestHarness(credentials: AiCredentialStore) {
  return createHarness(credentials, { fetch: async () => Response.json({}) })
}

function memoryCredentials(): AiCredentialStore {
  const records = new Map<string, AiCredentialRecord>()
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

function memoryPreferences(): AiPreferencesStore {
  let stored: AiPreferencesRecord | null = null
  return {
    get: async () => stored,
    put: async (preferences) => {
      stored = { ...preferences, updatedAt: 1_000 }
      return stored
    },
  }
}

function attempt(run: () => void): Error | null {
  try {
    run()
    return null
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
}
