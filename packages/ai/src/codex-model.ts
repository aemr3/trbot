import { getModel, type Model } from "@mariozechner/pi-ai"

const CODEX_PROVIDER = "openai-codex"
const CODEX_API = "openai-codex-responses"
const CODEX_BASE_URL = "https://chatgpt.com/backend-api"

// What an unknown model is assumed to hold. Only used for the harness's own
// bookkeeping — the provider enforces the real limits — so a generous window is
// safer than a small one that would refuse a context ChatGPT would have accepted.
const ASSUMED_CONTEXT_WINDOW = 272_000
const ASSUMED_MAX_TOKENS = 128_000

/**
 * The model behind a ChatGPT-subscription call, named by id.
 *
 * The configured id stays free-form on purpose: `TRBOT_AI_MODEL` names whatever
 * ChatGPT currently serves, which moves faster than any bundled registry. So a
 * known id is taken from the harness's registry for its real pricing and limits,
 * and an unknown one is described here rather than refused — the alternative is a
 * server that will not start the day a new model appears.
 *
 * Cost is zero for a described model because a subscription call is not billed
 * per token, and reporting a guessed price would be worse than reporting none.
 */
export function codexModel(modelId: string): Model<"openai-codex-responses"> {
  const known = knownCodexModel(modelId)
  if (known) return known
  return {
    id: modelId,
    name: modelId,
    api: CODEX_API,
    provider: CODEX_PROVIDER,
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ASSUMED_CONTEXT_WINDOW,
    maxTokens: ASSUMED_MAX_TOKENS,
  }
}

function knownCodexModel(modelId: string): Model<"openai-codex-responses"> | null {
  // getModel is typed against the harness's generated registry, so a runtime id
  // needs a cast to reach it. Its declared return type overstates the contract:
  // an id the registry does not carry comes back undefined, not thrown.
  const model = getModel(CODEX_PROVIDER, modelId as never) as Model<"openai-codex-responses"> | undefined
  return model ?? null
}
