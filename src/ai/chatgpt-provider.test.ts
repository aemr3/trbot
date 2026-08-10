import { expect, test } from "bun:test"
import { ChatGptAccountService } from "./chatgpt-account.ts"
import { createChatGptFetch } from "./chatgpt-provider.ts"
import type { ProviderStateStore } from "./provider-state.ts"

test("routes AI SDK responses through ChatGPT with refreshed session headers", async () => {
  const store: ProviderStateStore = {
    async get() {
      return {
        providerId: "openai",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
        accountId: "account-1",
        email: null,
        createdAt: 1,
        updatedAt: 1,
      }
    },
    async put() {},
    async delete() {},
  }
  const account = new ChatGptAccountService(store)
  const received: Request[] = []
  const chatGptFetch = createChatGptFetch(account, {
    endpoint: "https://chatgpt.test/backend-api/codex/responses",
    fetch: async (input, init) => {
      received.push(new Request(input, init))
      return Response.json({ ok: true })
    },
  })

  await chatGptFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer dummy", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", input: "Analyze" }),
  })

  const request = received[0]
  expect(request?.url).toBe("https://chatgpt.test/backend-api/codex/responses")
  expect(request?.headers.get("Authorization")).toBe("Bearer access-1")
  expect(request?.headers.get("ChatGPT-Account-Id")).toBe("account-1")
  expect(request?.headers.get("originator")).toBe("trbot")
  expect(await request?.json()).toMatchObject({ model: "gpt-5.4", input: "Analyze", store: false })
})

test("rejects AI SDK endpoints outside the Codex Responses transport", async () => {
  const store: ProviderStateStore = {
    async get() {
      return {
        providerId: "openai",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
        accountId: "account-1",
        email: null,
        createdAt: 1,
        updatedAt: 1,
      }
    },
    async put() {},
    async delete() {},
  }
  const chatGptFetch = createChatGptFetch(new ChatGptAccountService(store))

  await expect(chatGptFetch("https://api.openai.com/v1/embeddings")).rejects.toThrow("Responses models only")
})
