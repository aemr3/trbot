import {
  createProvider,
  type Api,
  type CreateProviderOptions,
  type Model,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai"
import { z } from "zod"

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev"
const DEFAULT_TIMEOUT_MS = 4_000

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const CostRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
})
const ModelSchema: z.ZodType<Model<Api>> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.url(),
  reasoning: z.boolean(),
  thinkingLevelMap: z.partialRecord(ThinkingLevelSchema, z.string().nullable()).optional(),
  input: z.array(z.enum(["text", "image"])).min(1),
  cost: CostRatesSchema.extend({
    tiers: z.array(CostRatesSchema.extend({ inputTokensAbove: z.number().nonnegative() })).optional(),
  }),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  samplingParams: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // Compatibility is provider-protocol metadata owned by pi-ai. Keep it opaque
  // here while still refusing non-object values at the HTTP boundary.
  compat: z.record(z.string(), z.json()).optional(),
}).passthrough()
const CatalogSchema = z.union([
  z.array(ModelSchema),
  z.object({ models: z.array(ModelSchema) }).transform(({ models }) => models),
  z.record(z.string(), ModelSchema).transform((models) => Object.values(models)),
])

export interface RemoteCatalogOptions {
  baseUrl?: string
  fetch?: RemoteCatalogFetch
  localGeneratedAt?: number
  timeoutMs?: number
  userAgent?: string
}

export type RemoteCatalogFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** Adds pi.dev's current model overlay to one of pi-ai's static providers. */
export function withRemoteCatalog(
  provider: Provider,
  options: RemoteCatalogOptions = {},
): Provider {
  const input: CreateProviderOptions = {
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    models: provider.getModels(),
    fetchModels: (context) => fetchRemoteModels(provider.id, context, options),
    api: provider,
  }
  if (provider.baseUrl !== undefined) input.baseUrl = provider.baseUrl
  if (provider.headers !== undefined) input.headers = provider.headers
  if (provider.filterModels !== undefined) input.filterModels = provider.filterModels
  return createProvider(input)
}

async function fetchRemoteModels(
  providerId: string,
  context: RefreshModelsContext,
  options: RemoteCatalogOptions,
): Promise<readonly Model<Api>[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL
  const request = options.fetch ?? globalThis.fetch
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ])
  const headers = new Headers({ accept: "application/json" })
  if (options.userAgent !== undefined) headers.set("User-Agent", options.userAgent)
  const response = await request(
    new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, baseUrl),
    {
      headers,
      signal,
    },
  )
  if (!response.ok) throw new Error(`Model catalog request failed for ${providerId}: ${response.status}`)

  const lastModified = Date.parse(response.headers.get("last-modified") ?? "")
  if (
    options.localGeneratedAt !== undefined
    && !Number.isNaN(lastModified)
    && lastModified <= options.localGeneratedAt
  ) {
    return []
  }

  return decodeCatalog(providerId, CatalogSchema.parse(await response.json()))
}

function decodeCatalog(providerId: string, catalog: z.output<typeof CatalogSchema>): Model<Api>[] {
  return catalog.map((model) => ({ ...model, provider: providerId }))
}
