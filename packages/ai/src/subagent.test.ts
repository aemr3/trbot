import { expect, test } from "bun:test"
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import type { ChatMessageDraft } from "@trbot/chat/session.ts"
import { ChatAgent } from "./chat.ts"
import { subagentTool, type SubagentSessionRecorder } from "./subagent.ts"
import { ChatTools, toolText, type ChatTool } from "./tool.ts"
import { z } from "zod"

function harness(responseCount: number, response: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number]) {
  const faux = fauxProvider({ models: [{ id: "worker-model", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: responseCount }, () => response))
  return { faux, models }
}

test("runs a single worker with every non-delegation parent tool", async () => {
  const { faux, models } = harness(1, (context) => {
    expect(context.systemPrompt).toContain("general-purpose subagent")
    expect(context.systemPrompt).toContain("Do not delegate or create further subagents")
    expect(context.tools?.map((tool) => tool.name)).toEqual(["web_search"])
    return fauxAssistantMessage("Worker result.")
  })
  const tools = new ChatTools([passthroughTool("web_search")])
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-1",
    name: "subagent",
    arguments: { agent: "worker", task: "Do the work" },
  }, { model: faux.getModel(), reasoningEffort: "high" })

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toBe("Subagent worker completed.")
  expect(outcome.modelBlocks?.[0]?.text).toBe("Worker result.")
  expect(outcome.usage?.totalTokens).toBeGreaterThan(0)
})

test("records a worker's complete isolated session when a parent chat is available", async () => {
  const { faux, models } = harness(1, fauxAssistantMessage([
    fauxThinking("Checking the market."),
    fauxText("Worker result."),
  ]))
  const started: unknown[] = []
  interface RecordedDeltas {
    text: string
    reasoning: string
    tools: string[]
  }
  const deltas: RecordedDeltas = { text: "", reasoning: "", tools: [] }
  const messages: ChatMessageDraft[] = []
  const finishes: Array<string | null> = []
  const recorder: SubagentSessionRecorder = {
    async start(input) {
      started.push(input)
      return {
        sessionId: "child-1",
        onText: (delta) => { deltas.text += delta },
        onReasoning: (delta) => { deltas.reasoning += delta },
        onToolCall: (name) => { deltas.tools.push(name) },
        onRetry: () => {},
        onMessage: async (draft) => { messages.push(draft) },
        finish: async (error) => { finishes.push(error) },
      }
    },
  }
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools, recorder))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-recorded",
    name: "subagent",
    arguments: { agent: "worker", task: "Inspect ASELS" },
  }, { model: faux.getModel(), reasoningEffort: "high", chatSessionId: "parent-1" })

  expect(started).toEqual([{
    parentSessionId: "parent-1",
    parentToolCallId: "subagent-recorded",
    agent: "worker",
    task: "Inspect ASELS",
    providerId: faux.getModel().provider,
    modelId: faux.getModel().id,
    reasoning: "high",
  }])
  expect(deltas).toEqual({ text: "Worker result.", reasoning: "Checking the market.", tools: [] })
  expect(messages.map((draft) => draft.message.role)).toEqual(["ASSISTANT"])
  const details = z.object({ results: z.array(z.object({ sessionId: z.string().nullable() })) }).parse(outcome.details)
  expect(details.results[0]?.sessionId).toBe("child-1")
  expect(finishes).toEqual([null])
})

test("reports a worker retry without rerunning its completed tool", async () => {
  const faux = fauxProvider({ models: [{ id: "worker-model", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_market", {})], { stopReason: "toolUse" }),
    async (_context, options, _state, model) => {
      await options?.onResponse?.({ status: 503, headers: { "retry-after-ms": "0" } }, model)
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Service unavailable" })
    },
    fauxAssistantMessage("Worker recovered."),
  ])
  let toolCalls = 0
  const readMarket: ChatTool = {
    definition: { name: "read_market", description: "Read market data", parameters: Type.Object({}) },
    run: async () => {
      toolCalls += 1
      return { blocks: [toolText("Market read.")], details: null, isError: false }
    },
  }
  const retries: unknown[] = []
  const recorder: SubagentSessionRecorder = {
    start: async () => ({
      sessionId: "child-retry",
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: (status) => { retries.push(status) },
      onMessage: async () => {},
      finish: async () => {},
    }),
  }
  const tools = new ChatTools([readMarket])
  tools.register(subagentTool(models, tools, recorder))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-retry",
    name: "subagent",
    arguments: { agent: "worker", task: "Read the market" },
  }, { model: faux.getModel(), chatSessionId: "parent-1" })

  expect(outcome.isError).toBe(false)
  expect(outcome.modelBlocks?.[0]?.text).toBe("Worker recovered.")
  expect(faux.state.callCount).toBe(3)
  expect(toolCalls).toBe(1)
  expect(retries).toHaveLength(2)
  expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 5, message: "Provider is overloaded" })
  expect(retries[1]).toBeNull()
})

test("runs at most four of eight parallel workers at once", async () => {
  let active = 0
  let maximumActive = 0
  const pause: ChatTool = {
    definition: { name: "pause", description: "Pause briefly", parameters: Type.Object({}) },
    run: async (_args, options) => {
      expect(options.chatSessionId).toBe("chat-1")
      active++
      maximumActive = Math.max(maximumActive, active)
      await Bun.sleep(10)
      active--
      return { blocks: [toolText("continued")], details: null, isError: false }
    },
  }
  const { faux, models } = harness(16, (context) => (
    context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("Finished.")
      : fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" })
  ))
  const tools = new ChatTools([pause])
  tools.register(subagentTool(models, tools))
  const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: "worker", task: `Task ${index + 1}` }))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-parallel",
    name: "subagent",
    arguments: { tasks },
  }, { model: faux.getModel(), chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toBe("Parallel: 8/8 succeeded")
  expect(maximumActive).toBe(4)
  expect(faux.state.callCount).toBe(16)
})

test("rejects more than eight parallel tasks before starting a worker", async () => {
  const { faux, models } = harness(1, fauxAssistantMessage("Should not run."))
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))
  const tasks = Array.from({ length: 9 }, (_, index) => ({ agent: "worker", task: `Task ${index + 1}` }))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-too-many",
    name: "subagent",
    arguments: { tasks },
  }, { model: faux.getModel() })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toBe("Too many parallel tasks (9). Max is 8.")
  expect(faux.state.callCount).toBe(0)
})

test("reports the shared turn limit and lets the parent agent continue", async () => {
  const { faux, models } = harness(11, (context) => {
    if (context.systemPrompt?.includes("general-purpose subagent")) {
      return fauxAssistantMessage("Worker result.")
    }

    const toolResults = context.messages.filter((message) => message.role === "toolResult")
    if (toolResults.length === 0) {
      return fauxAssistantMessage([fauxToolCall("subagent", {
        tasks: Array.from({ length: 8 }, (_, index) => ({ agent: "worker", task: `Task ${index + 1}` })),
      })], { stopReason: "toolUse" })
    }
    if (toolResults.length === 1) {
      return fauxAssistantMessage([
        fauxToolCall("subagent", { agent: "worker", task: "One more task" }),
      ], { stopReason: "toolUse" })
    }

    expect(toolResults.at(-1)).toMatchObject({ role: "toolResult", isError: true })
    expect(JSON.stringify(toolResults.at(-1))).toContain("Subagent limit reached")
    return fauxAssistantMessage("Continued without another worker.")
  })
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))
  const messages: ChatMessageDraft[] = []
  const agent = new ChatAgent({ models, tools })

  const result = await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Delegate this work",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: () => {},
      onMessage: async (draft) => { messages.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(messages.at(-1)?.message.text).toBe("Continued without another worker.")
  expect(faux.state.callCount).toBe(11)
})

test("hides delegation from workers and rejects a hallucinated nested call", async () => {
  const faux = fauxProvider({ models: [{ id: "worker-model", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Outer task" })
      expect(context.tools?.map((tool) => tool.name)).toEqual(["web_search"])
      return fauxAssistantMessage([
        fauxToolCall("subagent", { agent: "worker", task: "Nested task" }),
      ], { stopReason: "toolUse" })
    },
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true })
      expect(JSON.stringify(context.messages.at(-1))).toContain("Workers cannot create further subagents")
      return fauxAssistantMessage("Outer worker continued.")
    },
  ])
  const tools = new ChatTools([passthroughTool("web_search")])
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-depth",
    name: "subagent",
    arguments: { agent: "worker", task: "Outer task" },
  }, { model: faux.getModel() })

  expect(outcome.isError).toBe(false)
  expect(outcome.modelBlocks?.[0]?.text).toBe("Outer worker continued.")
  expect(faux.state.callCount).toBe(2)
})

test("enforces the nesting limit when a nested call reaches the root registry", async () => {
  const { faux, models } = harness(1, fauxAssistantMessage("Should not run."))
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-depth",
    name: "subagent",
    arguments: { agent: "worker", task: "Nested task" },
  }, {
    model: faux.getModel(),
    delegation: { depth: 1, budget: { created: 0 } },
  })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("Subagent nesting limit reached (1 level)")
  expect(faux.state.callCount).toBe(0)
})

test("runs a chain sequentially and substitutes the previous output", async () => {
  const faux = fauxProvider({ models: [{ id: "worker-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage("First result."),
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Review First result." })
      return fauxAssistantMessage("Final result.")
    },
  ])
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-chain",
    name: "subagent",
    arguments: {
      chain: [
        { agent: "worker", task: "Make a result" },
        { agent: "worker", task: "Review {previous}" },
      ],
    },
  }, { model: faux.getModel() })

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toBe("Chain completed 2 steps.")
  expect(outcome.modelBlocks?.[0]?.text).toBe("Final result.")
  expect(outcome.usage?.totalTokens).toBeGreaterThan(0)
})

test("requires exactly one execution mode", async () => {
  const { faux, models } = harness(1, fauxAssistantMessage("Should not run."))
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-invalid",
    name: "subagent",
    arguments: {
      agent: "worker",
      task: "Single task",
      tasks: [{ agent: "worker", task: "Parallel task" }],
    },
  }, { model: faux.getModel() })

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("Provide exactly one mode")
  expect(faux.state.callCount).toBe(0)
})

function passthroughTool(name: string): ChatTool {
  return {
    definition: { name, description: name, parameters: Type.Object({}) },
    run: async () => ({ blocks: [], details: null, isError: false }),
  }
}
