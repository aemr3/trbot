import { describe, expect, test } from "bun:test"
import { createModels, fauxProvider, type Api, type Model } from "@earendil-works/pi-ai"
import { refreshConfiguredModels } from "./harness.ts"
import { withRemoteCatalog } from "./remote-catalog.ts"

describe("remote model catalog", () => {
  test("merges pi.dev models over the bundled provider in memory", async () => {
    const baseline = fauxProvider({ provider: "catalog-test", models: [{ id: "existing" }] })
    const requested: string[] = []
    const provider = withRemoteCatalog(baseline.provider, {
      fetch: async (input) => {
        requested.push(String(input))
        return Response.json({
          existing: model("existing", { name: "Updated existing" }),
          current: model("current"),
        })
      },
    })
    const models = createModels()
    models.setProvider(provider)

    await models.refresh({ force: true })

    expect(requested).toEqual(["https://pi.dev/api/models/providers/catalog-test"])
    expect(models.getModels("catalog-test").map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "existing", name: "Updated existing" },
      { id: "current", name: "current" },
    ])
  })

  test("keeps the last usable in-memory catalog when a refresh fails", async () => {
    const baseline = fauxProvider({ provider: "catalog-test", models: [{ id: "existing" }] })
    let available = true
    const provider = withRemoteCatalog(baseline.provider, {
      fetch: async () => available
        ? Response.json({ current: model("current") })
        : new Response("unavailable", { status: 503 }),
    })
    const models = createModels()
    models.setProvider(provider)

    expect((await models.refresh()).errors.size).toBe(0)
    available = false
    const failed = await models.refresh({ force: true })

    expect(failed.errors.get("catalog-test")?.message).toContain("503")
    expect(models.getModel("catalog-test", "current")).toBeDefined()
  })

  test("startup refresh only contacts configured providers", async () => {
    const configured = fauxProvider({ provider: "configured" })
    const disconnected = fauxProvider({ provider: "disconnected" })
    const requested: string[] = []
    const request = async (input: string | URL | Request): Promise<Response> => {
      requested.push(String(input))
      return Response.json({ current: model("current") })
    }
    const models = createModels()
    models.setProvider(withRemoteCatalog(configured.provider, { fetch: request }))
    models.setProvider(withRemoteCatalog({
      ...disconnected.provider,
      auth: { apiKey: { name: "Disconnected", resolve: async () => undefined } },
    }, { fetch: request }))

    await refreshConfiguredModels(models)

    expect(requested).toEqual(["https://pi.dev/api/models/providers/configured"])
  })
})

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: "faux",
    provider: "catalog-test",
    baseUrl: "https://example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  }
}
