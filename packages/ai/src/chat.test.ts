import { expect, test } from "bun:test"
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai"
import type { ChatMessageDraft } from "@trbot/chat/session.ts"
import { ChatAgent, type ChatRecord } from "./chat.ts"
import { ChatTools, toolText, type ChatTool } from "./tool.ts"

test("streams a reply and hands over the message it produced", async () => {
  const faux = registerFauxProvider({ models: [{ id: "chat-model", reasoning: true }] })
  faux.setResponses([fauxAssistantMessage([fauxThinking("thinking it over"), fauxText("Ankara.")])])
  const agent = new ChatAgent({ model: faux.getModel(), accessToken: async () => "token-1" })

  const text: string[] = []
  const reasoning: string[] = []
  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    history: [],
    prompt: "Capital of Turkey?",
    events: {
      onText: (delta) => text.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onToolCall: () => {},
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(text.join("")).toBe("Ankara.")
  expect(reasoning.join("")).toBe("thinking it over")
  expect(drafts).toHaveLength(1)
  expect(drafts[0]?.message.status).toBe("COMPLETE")
  expect(drafts[0]?.message.text).toBe("Ankara.")
  // The reasoning is kept as its own block rather than folded into the text: the
  // model needs it back to continue, and the transcript must not show it as speech.
  expect(drafts[0]?.message.blocks.map((block) => block.kind)).toEqual(["THINKING", "TEXT"])
  faux.unregister()
})

test("replays the stored history rather than only the new question", async () => {
  const faux = registerFauxProvider({ models: [{ id: "chat-model" }] })
  faux.setResponses([
    (context) => {
      // Every earlier turn plus the new question, in order: a session that replayed
      // less than this would answer as if the conversation had not happened.
      expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      return fauxAssistantMessage("Still Ankara.")
    },
  ])
  const agent = new ChatAgent({ model: faux.getModel(), accessToken: async () => "token-1" })
  const history: ChatRecord[] = [
    { role: "user", content: "Capital of Turkey?", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Ankara." }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "chat-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    },
  ]

  await agent.run({
    history,
    prompt: "Are you sure?",
    events: { onText: () => {}, onReasoning: () => {}, onToolCall: () => {}, onMessage: async () => {} },
  })
  faux.unregister()
})

test("runs the tools a reply asks for and answers with their results", async () => {
  const quote: ChatTool = {
    definition: {
      name: "quote",
      description: "The last price of a symbol",
      parameters: Type.Object({ symbol: Type.String() }),
    },
    run: async (args) => ({
      blocks: [toolText(`${(args as { symbol: string }).symbol} 390.00`)],
      details: { last: 390 },
      isError: false,
    }),
  }
  const faux = registerFauxProvider({ models: [{ id: "chat-model" }] })
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("quote", { symbol: "ASELS" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("ASELS last traded at 390.00."),
  ])
  const agent = new ChatAgent({
    model: faux.getModel(),
    accessToken: async () => "token-1",
    tools: new ChatTools([quote]),
  })

  const called: string[] = []
  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    history: [],
    prompt: "What is ASELS trading at?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: (name) => called.push(name),
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(result.completed).toBe(true)
  expect(called).toEqual(["quote"])
  // The reply asking for the tool, the tool's answer, and the reply that follows —
  // each persisted as it finished, so a run that died mid-way kept what it had.
  expect(drafts.map((draft) => draft.message.role)).toEqual(["ASSISTANT", "TOOL_RESULT", "ASSISTANT"])
  expect(drafts[1]?.message.text).toBe("ASELS 390.00")
  expect(drafts[2]?.message.text).toBe("ASELS last traded at 390.00.")
  faux.unregister()
})

test("a tool called with arguments it cannot use fails without running", async () => {
  // Arguments are raw model output and the far side of a trbot tool can move money,
  // so a call the schema rejects has to come back as something the model can
  // correct — never reach the tool.
  const calls: unknown[] = []
  const quote: ChatTool = {
    definition: {
      name: "quote",
      description: "The last price of a symbol",
      parameters: Type.Object({ symbol: Type.String() }),
    },
    run: async (args) => {
      calls.push(args)
      return { blocks: [], details: null, isError: false }
    },
  }
  const tools = new ChatTools([quote])

  const missing = await tools.call(
    { type: "toolCall", id: "call-1", name: "quote", arguments: {} },
    {},
  )
  expect(missing.isError).toBe(true)
  expect(calls).toEqual([])

  const unknown = await tools.call(
    { type: "toolCall", id: "call-2", name: "depth", arguments: {} },
    {},
  )
  expect(unknown.isError).toBe(true)
  expect(calls).toEqual([])

  // A type the schema can convert is converted rather than refused: models
  // routinely send a number where a string was asked for, and failing that would
  // waste a turn on something unambiguous.
  const coerced = await tools.call(
    { type: "toolCall", id: "call-3", name: "quote", arguments: { symbol: 42 } },
    {},
  )
  expect(coerced.isError).toBe(false)
  expect(calls).toEqual([{ symbol: "42" }])
})

test("keeps a reply that failed part way and reports why", async () => {
  const faux = registerFauxProvider({ models: [{ id: "chat-model" }] })
  faux.setResponses([
    fauxAssistantMessage([fauxText("Partial")], { stopReason: "error", errorMessage: "stream lost" }),
  ])
  const agent = new ChatAgent({ model: faux.getModel(), accessToken: async () => "token-1" })

  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    history: [],
    prompt: "Capital of Turkey?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(result.errorMessage).toBe("stream lost")
  // The words it managed are still stored: an answer cut off is worth more to the
  // trader than an empty transcript with an error beside it.
  expect(drafts[0]?.message.text).toBe("Partial")
  expect(drafts[0]?.message.status).toBe("FAILED")
  faux.unregister()
})
