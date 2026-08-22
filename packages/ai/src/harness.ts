import {
  cleanupSessionResources,
  createModels,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import manifest from "../package.json"
import type { AiCredentialStore } from "./credential-store.ts"
import { StoredCredentials } from "./credentials.ts"

/**
 * The model harness version stamped on every stored chat message.
 *
 * Read from this package's own pinned dependency rather than written out by hand,
 * because the process that stamps the rows is the server, which does not declare
 * the harness at all — a hand-written copy there would keep reporting the old
 * version after an upgrade, and a row that names the wrong version is worse than
 * one that names none. Exact because the pin is exact.
 */
export const HARNESS_VERSION = `pi-ai/${manifest.dependencies["@earendil-works/pi-ai"]}`

/**
 * The harness as the rest of this application refers to it.
 *
 * Named here so nothing outside this package imports the harness directly: which
 * harness it is stays one file's business.
 */
export type AiHarness = MutableModels

/**
 * The harness, holding every provider it ships with.
 *
 * All of them are registered, not a chosen one: which providers a trader can use is
 * decided by which credentials they have given us, and the harness answers that
 * question itself through `getAvailable()`. Registering the full set is also what
 * makes a new provider in a harness upgrade appear in the terminal with no code
 * change here.
 *
 * One object then owns the catalogue, credential resolution, and refresh, so nothing
 * in this application describes a model or exchanges a token by hand.
 */
export function createHarness(credentials: AiCredentialStore): AiHarness {
  const models = createModels({ credentials: new StoredCredentials(credentials) })
  for (const provider of builtinProviders()) models.setProvider(provider)
  return models
}

/**
 * Releases whatever the harness is holding open between requests.
 *
 * Its ChatGPT transport keeps a connection per session so a follow-up turn need not
 * resend the whole conversation. Chat turns pass their application session id into
 * the harness, so shutdown releases those cached provider connections explicitly.
 */
export function closeHarness(): void {
  cleanupSessionResources()
}

/**
 * A chosen model, or a refusal naming what that provider offers.
 *
 * Reached for when a stored choice has to become a request. A model that has
 * disappeared from the catalogue — a provider retired it, or an upgrade dropped it —
 * is refused rather than guessed at, because the alternative is a trade idea from a
 * model nobody picked.
 */
export function harnessModel(models: AiHarness, providerId: string, modelId: string): Model<Api> {
  const model = models.getModel(providerId, modelId)
  if (model) return model

  const provider = models.getProvider(providerId)
  if (!provider) throw new Error(`No provider named "${providerId}" — reconnect it and pick a model again`)

  const known = models
    .getModels(providerId)
    .map((candidate) => candidate.id)
    .slice(0, 8)
    .join(", ")
  throw new Error(`${provider.name} does not offer a model named "${modelId}". It offers: ${known}`)
}
