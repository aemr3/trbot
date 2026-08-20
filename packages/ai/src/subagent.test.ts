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

function harness(responseCount: number, response: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number]) {
  const faux = fauxProvider({ models: [{ id: "worker-model", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: responseCount }, () => response))
  return { faux, models }
}

test("runs a single worker with the complete parent tool registry", async () => {
  const { faux, models } = harness(1, (context) => {
    expect(context.systemPrompt).toContain("general-purpose subagent")
    expect(context.tools?.map((tool) => tool.name)).toEqual(["web_search", "subagent"])
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
  const deltas = { text: "", reasoning: "", tools: [] as string[] }
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
    agent: "worker",
    task: "Inspect ASELS",
    providerId: faux.getModel().provider,
    modelId: faux.getModel().id,
    reasoning: "high",
  }])
  expect(deltas).toEqual({ text: "Worker result.", reasoning: "Checking the market.", tools: [] })
  expect(messages.map((draft) => draft.message.role)).toEqual(["ASSISTANT"])
  expect((outcome.details as { results: Array<{ sessionId: string }> }).results[0]?.sessionId).toBe("child-1")
  expect(finishes).toEqual([null])
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
      onMessage: async (draft) => { messages.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(messages.at(-1)?.message.text).toBe("Continued without another worker.")
  expect(faux.state.callCount).toBe(11)
})

test("reports the nesting limit to a worker without stopping its parent", async () => {
  const faux = fauxProvider({ models: [{ id: "worker-model", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Outer task" })
      return fauxAssistantMessage([
        fauxToolCall("subagent", { agent: "worker", task: "Nested task" }),
      ], { stopReason: "toolUse" })
    },
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Nested task" })
      return fauxAssistantMessage([
        fauxToolCall("subagent", { agent: "worker", task: "Too deep" }),
      ], { stopReason: "toolUse" })
    },
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true })
      expect(JSON.stringify(context.messages.at(-1))).toContain("Subagent nesting limit reached")
      return fauxAssistantMessage("Nested worker continued.")
    },
    (context) => {
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: false })
      return fauxAssistantMessage("Outer worker continued.")
    },
  ])
  const tools = new ChatTools()
  tools.register(subagentTool(models, tools))

  const outcome = await tools.call({
    type: "toolCall",
    id: "subagent-depth",
    name: "subagent",
    arguments: { agent: "worker", task: "Outer task" },
  }, { model: faux.getModel() })

  expect(outcome.isError).toBe(false)
  expect(outcome.modelBlocks?.[0]?.text).toBe("Outer worker continued.")
  expect(faux.state.callCount).toBe(4)
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
