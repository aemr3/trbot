import {
  cleanupSessionResources,
  createModels,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import manifest from "../package.json"
import { StoredCredentials } from "./credentials.ts"
import { CHATGPT_PROVIDER_ID } from "./provider-state.ts"
import type { ProviderStateStore } from "./provider-state.ts"

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
 * The harness, configured for this application.
 *
 * One object owns the model catalogue, credential resolution, and token refresh,
 * so nothing here re-describes a model or refreshes a token by hand: the provider
 * knows its own models, endpoints, prices, and thinking levels, and the harness
 * refreshes against the stored connection whenever a request needs it.
 */
export function createHarness(states: ProviderStateStore): AiHarness {
  const models = createModels({ credentials: new StoredCredentials(states) })
  models.setProvider(openaiCodexProvider())
  return models
}

/**
 * Releases whatever the harness is holding open between requests.
 *
 * Its ChatGPT transport keeps a connection per session so a follow-up turn need
 * not resend the whole conversation. Nothing here names a session yet, so there is
 * usually nothing to release — but a shutdown that says so is what keeps that true
 * the day one is named.
 */
export function closeHarness(): void {
  cleanupSessionResources()
}

/**
 * The configured model, or a refusal naming what is on offer.
 *
 * `TRBOT_AI_MODEL` is free-form because it names whatever ChatGPT currently
 * serves. An id the harness does not know used to be described here from
 * guesses; now it is refused, because a guessed context window and a guessed
 * price are worse than a startup error that lists the ids that work.
 */
export function harnessModel(models: AiHarness, modelId: string): Model<Api> {
  const model = models.getModel(CHATGPT_PROVIDER_ID, modelId)
  if (model) return model

  const known = models
    .getModels(CHATGPT_PROVIDER_ID)
    .map((candidate) => candidate.id)
    .join(", ")
  throw new Error(`TRBOT_AI_MODEL is set to "${modelId}", which this harness does not know. It offers: ${known}`)
}
