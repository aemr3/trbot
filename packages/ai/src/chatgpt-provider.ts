import { createOpenAI, type OpenAIProvider, type OpenAIProviderSettings } from "@ai-sdk/openai"
import type { ChatGptAccountService } from "./chatgpt-account.ts"

const CHATGPT_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_DUMMY_KEY = "chatgpt-oauth"

interface ChatGptProviderOptions {
  endpoint?: string
  fetch?: HttpFetch
}

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function createChatGptProvider(
  account: ChatGptAccountService,
  options: ChatGptProviderOptions = {},
): OpenAIProvider {
  return createOpenAI({
    apiKey: OAUTH_DUMMY_KEY,
    fetch: createChatGptFetch(account, options),
  })
}

export function createChatGptModel(
  account: ChatGptAccountService,
  modelId: string,
  options: ChatGptProviderOptions = {},
) {
  return createChatGptProvider(account, options).responses(modelId)
}

export function createChatGptFetch(
  account: ChatGptAccountService,
  options: ChatGptProviderOptions = {},
): NonNullable<OpenAIProviderSettings["fetch"]> {
  const request = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoint ?? CHATGPT_RESPONSES_ENDPOINT

  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const state = await account.validState()
    const source = input instanceof Request ? input : null
    const sourceUrl = source?.url ?? String(input)
    const url = new URL(sourceUrl)
    const headers = new Headers(source?.headers)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set("Authorization", `Bearer ${state.accessToken}`)
    headers.set("originator", "trbot")
    headers.set("User-Agent", "trbot")
    if (state.accountId) headers.set("ChatGPT-Account-Id", state.accountId)
    if (!url.pathname.endsWith("/responses")) {
      throw new Error("ChatGPT OAuth supports AI SDK Responses models only")
    }
    const body = statelessBody(init?.body)

    return request(endpoint, {
      ...init,
      headers,
      body,
    })
  }
  return Object.assign(authenticatedFetch, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })
}

function statelessBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body
  try {
    const value = JSON.parse(body) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return body
    return JSON.stringify({ ...value, store: false })
  } catch {
    return body
  }
}
