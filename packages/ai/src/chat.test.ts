import { expect, test } from "bun:test"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import type { ChatMessageDraft } from "@trbot/chat/session.ts"
import { CHAT_SYSTEM_PROMPT, ChatAgent, type ChatRecord } from "./chat.ts"
import { steeringPrompt } from "./steering.ts"
import { ChatTools, toolText, type ChatTool } from "./tool.ts"

/** A harness answering with scripted replies, as the harness's own tests do it. */
function scripted(options: { reasoning?: boolean } = {}) {
  const faux = fauxProvider({ models: [{ id: "chat-model", ...options }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models }
}

const ignoreRetry = (): void => {}

test("tells the agent to check live app data before claiming it has none", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain("do not claim live data is unavailable before checking")
  expect(CHAT_SYSTEM_PROMPT).toContain("Never infer or assume prices")
  expect(CHAT_SYSTEM_PROMPT).toContain("Read it from a tool")
})

test("keeps the agent inside the listed front-month contract universe", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain("only the nearest-expiry contract")
  expect(CHAT_SYSTEM_PROMPT).toContain("Never construct or probe a contract code")
  expect(CHAT_SYSTEM_PROMPT).toContain("outside the available universe")
})

test("teaches the agent VIOP exposure and the difference between limits and circuit breakers", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain("Collateral is margin, not the purchase price")
  expect(CHAT_SYSTEM_PROMPT).toContain("live lowerLimit and upperLimit")
  expect(CHAT_SYSTEM_PROMPT).toContain("daily price margin from a circuit breaker")
  expect(CHAT_SYSTEM_PROMPT).toContain("BIST 100 fall of 6%")
  expect(CHAT_SYSTEM_PROMPT).toContain("current official Borsa Istanbul source")
  expect(CHAT_SYSTEM_PROMPT).toContain("get_order_book can read either the VIOP contract book")
  expect(CHAT_SYSTEM_PROMPT).toContain("target INSTRUMENT")
  expect(CHAT_SYSTEM_PROMPT).toContain("target UNDERLYING")
  expect(CHAT_SYSTEM_PROMPT).toContain("never describe an underlying order book as a futures order book")
  expect(CHAT_SYSTEM_PROMPT).toContain("equity quotes still belong to an available cash-equity underlying")
  expect(CHAT_SYSTEM_PROMPT).toContain("none proves trade direction by itself")
  expect(CHAT_SYSTEM_PROMPT).toContain("not independent proof of a setup")
  expect(CHAT_SYSTEM_PROMPT).toContain("Use get_intraday_context for a first-pass")
  expect(CHAT_SYSTEM_PROMPT).toContain("latest completed candle for confirmation")
  expect(CHAT_SYSTEM_PROMPT).toContain("forming-candle reading as provisional")
  expect(CHAT_SYSTEM_PROMPT).toContain("what happened at trigger time, not current market data")
  expect(CHAT_SYSTEM_PROMPT).not.toContain("permission")
})

test("separates immediate goals from scheduled and event-driven monitoring", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain("finite work with a verifiable end state")
  expect(CHAT_SYSTEM_PROMPT).toContain("never use one to wait, poll, monitor until a time")
  expect(CHAT_SYSTEM_PROMPT).toContain("Use one dynamic loop for autonomous time-based monitoring")
  expect(CHAT_SYSTEM_PROMPT).toContain("never combine an active goal and active loop in the same chat")
})

test("streams a reply and hands over the message it produced", async () => {
  const { faux, models } = scripted({ reasoning: true })
  faux.setResponses([fauxAssistantMessage([fauxThinking("thinking it over"), fauxText("Ankara.")])])
  const agent = new ChatAgent({ models })

  const text: string[] = []
  const reasoning: string[] = []
  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Capital of Turkey?",
    events: {
      onText: (delta) => text.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onToolCall: () => {},
      onRetry: ignoreRetry,
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
})

test("replays the stored history rather than only the new question", async () => {
  const { faux, models } = scripted()
  let replayedRoles: string[] = []
  faux.setResponses([
    (context) => {
      // Every earlier turn plus the new question, in order: a session that replayed
      // less than this would answer as if the conversation had not happened.
      replayedRoles = context.messages.map((message) => message.role)
      return fauxAssistantMessage("Still Ankara.")
    },
  ])
  const agent = new ChatAgent({ models })
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
    model: faux.getModel(),
    history,
    prompt: "Are you sure?",
    events: { onText: () => {}, onReasoning: () => {}, onToolCall: () => {}, onRetry: ignoreRetry, onMessage: async () => {} },
  })

  expect(replayedRoles).toEqual(["user", "assistant", "user"])
})

test("runs the tools a reply asks for and answers with their results", async () => {
  const QuoteParameters = Type.Object({ symbol: Type.String() })
  const quote: ChatTool<typeof QuoteParameters> = {
    definition: {
      name: "quote",
      description: "The last price of a symbol",
      parameters: QuoteParameters,
    },
    run: async (args, options) => {
      expect(options.chatSessionId).toBe("chat-1")
      return {
        blocks: [toolText(`Fetched ${args.symbol} quote.`)],
        modelBlocks: [toolText(`${args.symbol} 390.00`)],
        isError: false,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0.01 },
      }
    },
  }
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("quote", { symbol: "ASELS" })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.at(-1)
      expect(result?.role).toBe("toolResult")
      if (result?.role === "toolResult") {
        expect("details" in result).toBe(false)
        const content = result.content[0]
        expect(content?.type).toBe("text")
        if (content?.type === "text") expect(content.text).toBe("ASELS 390.00")
        expect(result.usage?.totalTokens).toBe(15)
        expect(result.usage?.cost.total).toBe(0.01)
      }
      return fauxAssistantMessage("ASELS last traded at 390.00.")
    },
  ])
  const agent = new ChatAgent({ models, tools: new ChatTools([quote]) })

  const called: string[] = []
  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "What is ASELS trading at?",
    chatSessionId: "chat-1",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: (name) => { called.push(name) },
      onRetry: ignoreRetry,
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
  expect(drafts[1]?.message.text).toBe("Fetched ASELS quote.")
  expect(drafts[1]?.message.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0.01 })
  expect(drafts[2]?.message.text).toBe("ASELS last traded at 390.00.")
})

test("keeps optional tool metadata when a future consumer opts into it", async () => {
  const inspect: ChatTool = {
    definition: { name: "inspect", description: "Inspect data", parameters: Type.Object({}) },
    run: async () => ({
      blocks: [toolText("Inspected.")],
      details: { source: "future-renderer" },
      isError: false,
    }),
  }
  const { faux, models } = scripted()
  let toolDetails: unknown
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.at(-1)
      toolDetails = result?.role === "toolResult" ? result.details : undefined
      return fauxAssistantMessage("Done.")
    },
  ])

  await new ChatAgent({ models, tools: new ChatTools([inspect]) }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Inspect it",
    events: { onText: () => {}, onReasoning: () => {}, onToolCall: () => {}, onRetry: ignoreRetry, onMessage: async () => {} },
  })

  expect(toolDetails).toEqual({ source: "future-renderer" })
})

test("applies steering after the current tool batch and before the next model call", async () => {
  const inspect: ChatTool = {
    definition: {
      name: "inspect_stop",
      description: "Read the current stop",
      parameters: Type.Object({}),
    },
    run: async () => ({ blocks: [toolText("Stop is 420.")], isError: false }),
  }
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("inspect_stop", {})], { stopReason: "toolUse" }),
    (context) => {
      expect(context.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "user",
      ])
      expect(JSON.stringify(context.messages.at(-1))).toContain("your stop is too close")
      return fauxAssistantMessage("I widened the stop.")
    },
  ])
  const agent = new ChatAgent({ models, tools: new ChatTools([inspect]) })
  let polls = 0

  const result = await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Manage the position",
    steering: async () => {
      polls += 1
      return polls === 1
        ? [{ role: "user", content: steeringPrompt("your stop is too close"), timestamp: 2 }]
        : []
    },
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async () => {},
    },
  })

  expect(result.completed).toBe(true)
  expect(polls).toBe(2)
})

test("waits for tool-start delivery before running the tool", async () => {
  const startObserved = Promise.withResolvers<void>()
  const startDelivered = Promise.withResolvers<void>()
  let toolRan = false
  const quote: ChatTool = {
    definition: {
      name: "quote",
      description: "The last price of a symbol",
      parameters: Type.Object({}),
    },
    run: async () => {
      toolRan = true
      return { blocks: [toolText("Fetched quote.")], isError: false }
    },
  }
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("quote", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ])
  const agent = new ChatAgent({ models, tools: new ChatTools([quote]) })

  const running = agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Fetch it",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: async () => {
        startObserved.resolve()
        await startDelivered.promise
      },
      onRetry: ignoreRetry,
      onMessage: async () => {},
    },
  })

  await startObserved.promise
  expect(toolRan).toBe(false)
  startDelivered.resolve()
  await running
  expect(toolRan).toBe(true)
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
      return { blocks: [], isError: false }
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

test("reports accepted enum values once when a tool argument is invalid", async () => {
  const CandleParameters = Type.Object({
    interval: Type.Union([Type.Literal("MIN_5"), Type.Literal("MIN_15")]),
  })
  const calls: unknown[] = []
  const candles: ChatTool<typeof CandleParameters> = {
    definition: {
      name: "get_candles",
      description: "Read candles",
      parameters: CandleParameters,
    },
    run: async (args) => {
      calls.push(args)
      return { blocks: [], isError: false }
    },
  }

  const result = await new ChatTools([candles]).call(
    { type: "toolCall", id: "call-1", name: "get_candles", arguments: { interval: "MIN_10" } },
    {},
  )

  expect(result.isError).toBe(true)
  expect(result.blocks).toEqual([toolText([
    "Invalid arguments for tool \"get_candles\":",
    "  - interval: expected one of MIN_5, MIN_15",
    'Received arguments: {"interval":"MIN_10"}',
  ].join("\n"))])
  expect(calls).toEqual([])
})

test("keeps a reply that failed part way and reports why", async () => {
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxText("Partial")], {
      stopReason: "error",
      errorMessage: "WebSocket closed 1006 Connection ended",
    }),
  ])
  const agent = new ChatAgent({ models })

  const drafts: ChatMessageDraft[] = []
  const result = await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Capital of Turkey?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(result.errorMessage).toBe("WebSocket closed 1006 Connection ended")
  // The words it managed are still stored: an answer cut off is worth more to the
  // trader than an empty transcript with an error beside it.
  expect(drafts[0]?.message.text).toBe("Partial")
  expect(drafts[0]?.message.status).toBe("FAILED")
})

test("retries provider overloads with bounded backoff", async () => {
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
    }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
    }),
    fauxAssistantMessage("Recovered answer."),
  ])
  const drafts: ChatMessageDraft[] = []
  const retries: unknown[] = []

  const result = await new ChatAgent({
    models,
    now: () => 1_000,
    random: () => 0,
    retryWait: async () => true,
  }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Capital of Turkey?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: (status) => { retries.push(status) },
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(faux.state.callCount).toBe(3)
  expect(drafts.map((draft) => draft.message.text)).toEqual(["Recovered answer."])
  expect(retries).toEqual([
    { attempt: 1, maxAttempts: 5, message: "Provider is overloaded", reportedAt: 1_000, nextAt: 3_000 },
    null,
    { attempt: 2, maxAttempts: 5, message: "Provider is overloaded", reportedAt: 1_000, nextAt: 5_000 },
    null,
  ])
})

test("retries an empty text block that never emitted user-visible text", async () => {
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "Service unavailable" }),
    fauxAssistantMessage("Recovered answer."),
  ])
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({ models, retryWait: async () => true }).run({
    model: faux.getModel(),
    history: [],
    prompt: "What changed?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result.completed).toBe(true)
  expect(faux.state.callCount).toBe(2)
  expect(drafts.map((draft) => draft.message.text)).toEqual(["Recovered answer."])
})

test("honors provider retry timing headers", async () => {
  const cases: Array<{ headers: Record<string, string>; expected: number }> = [
    { headers: { "retry-after-ms": "750" }, expected: 750 },
    { headers: { "retry-after-ms": "999999999999" }, expected: 2_147_483_647 },
    { headers: { "Retry-After": "3.5" }, expected: 3_500 },
    { headers: { "retry-after": new Date(6_000).toUTCString() }, expected: 5_000 },
  ]

  for (const { headers, expected } of cases) {
    const { faux, models } = scripted()
    faux.setResponses([
      async (_context, options, _state, model) => {
        expect(options?.maxRetries).toBe(0)
        await options?.onResponse?.({ status: 429, headers }, model)
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Service unavailable" })
      },
      fauxAssistantMessage("Recovered answer."),
    ])
    const delays: number[] = []

    const result = await new ChatAgent({
      models,
      now: () => 1_000,
      random: () => 1,
      retryWait: async (delayMs) => {
        delays.push(delayMs)
        return true
      },
    }).run({
      model: faux.getModel(),
      history: [],
      prompt: "What changed?",
      events: {
        onText: () => {},
        onReasoning: () => {},
        onToolCall: () => {},
        onRetry: ignoreRetry,
        onMessage: async () => {},
      },
    })

    expect(result.completed).toBe(true)
    expect(delays).toEqual([expected])
  }
})

test("captures retry headers from failed provider fetches", async () => {
  const faux = fauxProvider({ api: "openai-responses", models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    async (_context, options) => {
      await options?.fetch?.("https://provider.test/responses")
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429: Too many requests" })
    },
    fauxAssistantMessage("Recovered answer."),
  ])
  const delays: number[] = []

  const result = await new ChatAgent({
    models,
    fetch: async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "17" },
    }),
    retryWait: async (delayMs) => {
      delays.push(delayMs)
      return true
    },
  }).run({
    model: faux.getModel(),
    history: [],
    prompt: "What changed?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async () => {},
    },
  })

  expect(result.completed).toBe(true)
  expect(delays).toEqual([17_000])
})

test("adds jitter, caps unscheduled delays, and stops after five retries", async () => {
  const { faux, models } = scripted()
  faux.setResponses(Array.from({ length: 6 }, () => (
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "Service unavailable" })
  )))
  const delays: number[] = []
  const attempts: number[] = []
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({
    models,
    random: () => 1,
    retryWait: async (delayMs) => {
      delays.push(delayMs)
      return true
    },
  }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Keep trying?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: (status) => {
        if (status) attempts.push(status.attempt)
      },
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result).toEqual({ completed: false, aborted: false, errorMessage: "Service unavailable" })
  expect(faux.state.callCount).toBe(6)
  expect(attempts).toEqual([1, 2, 3, 4, 5])
  expect(delays).toEqual([2_500, 5_000, 10_000, 20_000, 30_000])
  expect(drafts).toHaveLength(1)
  expect(drafts[0]?.message.isError).toBe(true)
})

test("cancels immediately while waiting to retry", async () => {
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "Service unavailable" }),
    fauxAssistantMessage("Should not run."),
  ])
  const controller = new AbortController()
  const retries: unknown[] = []

  const result = await new ChatAgent({ models }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Stop during backoff",
    signal: controller.signal,
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: (status) => {
        retries.push(status)
        if (status) controller.abort()
      },
      onMessage: async () => {},
    },
  })

  expect(result).toEqual({ completed: false, aborted: true, errorMessage: null })
  expect(faux.state.callCount).toBe(1)
  expect(retries).toHaveLength(2)
  expect(retries.at(-1)).toBeNull()
})

test("retries an abnormal provider disconnect without running completed tools again", async () => {
  let toolCalls = 0
  const tool: ChatTool = {
    definition: {
      name: "read_market",
      description: "Read current market data",
      parameters: Type.Object({}),
    },
    run: async () => {
      toolCalls += 1
      return { blocks: [toolText("Market read.")], isError: false }
    },
  }
  const { faux, models } = scripted({ reasoning: true })
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_market", {})], { stopReason: "toolUse" }),
    (_context, options) => {
      expect(options?.sessionId).toBe("chat-1")
      return fauxAssistantMessage([fauxThinking("checking")], {
        stopReason: "error",
        errorMessage: "WebSocket closed 1006 Connection ended",
      })
    },
    (context, options) => {
      expect(options?.sessionId).toBe("chat-1")
      expect(context.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ])
      return fauxAssistantMessage("Recovered answer.")
    },
  ])
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({
    models,
    tools: new ChatTools([tool]),
    retryWait: async () => true,
  }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Read the market",
    chatSessionId: "chat-1",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(faux.state.callCount).toBe(3)
  expect(toolCalls).toBe(1)
  expect(drafts.map((draft) => draft.message.role)).toEqual(["ASSISTANT", "TOOL_RESULT", "ASSISTANT"])
  expect(drafts.at(-1)?.message.text).toBe("Recovered answer.")
})

test("keeps retrying a provider overload after a completed tool without running it again", async () => {
  let toolCalls = 0
  const tool: ChatTool = {
    definition: {
      name: "read_market",
      description: "Read current market data",
      parameters: Type.Object({}),
    },
    run: async () => {
      toolCalls += 1
      return { blocks: [toolText("Market read.")], isError: false }
    },
  }
  const overload = {
    stopReason: "error" as const,
    errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
  }
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_market", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([], overload),
    fauxAssistantMessage([], overload),
    fauxAssistantMessage([], overload),
    (context) => {
      expect(context.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ])
      return fauxAssistantMessage("Recovered after sustained overload.")
    },
  ])
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({
    models,
    tools: new ChatTools([tool]),
    retryWait: async () => true,
  }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Read the market",
    chatSessionId: "worker-1",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(faux.state.callCount).toBe(5)
  expect(toolCalls).toBe(1)
  expect(drafts.map((draft) => draft.message.role)).toEqual(["ASSISTANT", "TOOL_RESULT", "ASSISTANT"])
  expect(drafts.at(-1)?.message.text).toBe("Recovered after sustained overload.")
})

test("reports a clean context overflow without persisting a disposable error reply", async () => {
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "500: Your input exceeds the context window of this model",
    }),
  ])
  const drafts: ChatMessageDraft[] = []
  const result = await new ChatAgent({ models }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Continue",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result.overflowed).toBe(true)
  expect(faux.state.callCount).toBe(1)
  expect(drafts).toEqual([])
})

test("reports a recoverable partial response for compaction instead of persisting it", async () => {
  const { faux, models } = scripted()
  faux.setResponses([fauxAssistantMessage("Incomplete answer", { stopReason: "length" })])
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({ models }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Continue",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result.overflowed).toBe(true)
  expect(drafts).toEqual([])
})

test("preserves a successful response even when provider usage exceeds the window", async () => {
  const { faux, models } = scripted()
  faux.setResponses([fauxAssistantMessage("Completed oversized answer")])
  const drafts: ChatMessageDraft[] = []

  const result = await new ChatAgent({ models }).run({
    model: faux.getModel(),
    history: [],
    prompt: "x".repeat(480_000),
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(result).toEqual({ completed: true, aborted: false, errorMessage: null })
  expect(drafts.map((draft) => draft.message.text)).toEqual(["Completed oversized answer"])
})

test("does not retry an overflow after a tool has produced a durable side effect", async () => {
  let calls = 0
  const tool: ChatTool = {
    definition: {
      name: "remember",
      description: "Record a durable action",
      parameters: Type.Object({}),
    },
    run: async () => {
      calls += 1
      return {
        blocks: [toolText("Recorded.")],
        isError: false,
        effects: [{
          kind: "EXTERNAL",
          resourceId: null,
          description: "Durable action was recorded",
          reversible: false,
          before: null,
          after: null,
        }],
      }
    },
  }
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model",
    }),
  ])
  const drafts: ChatMessageDraft[] = []
  const result = await new ChatAgent({ models, tools: new ChatTools([tool]) }).run({
    model: faux.getModel(),
    history: [],
    prompt: "Remember this and continue",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => { drafts.push(draft) },
    },
  })

  expect(calls).toBe(1)
  expect(result.overflowed).toBeUndefined()
  expect(result.errorMessage).toContain("context window")
  expect(drafts.map((draft) => draft.message.role)).toEqual(["ASSISTANT", "TOOL_RESULT", "ASSISTANT"])
  expect(drafts[1]?.effects?.[0]?.description).toBe("Durable action was recorded")
})

test("stamps a reply with what answered it and the effort it was asked for", async () => {
  // The transcript labels each reply from this, not from the session, so a chat
  // pointed at another model does not relabel what came before.
  const { faux, models } = scripted({ reasoning: true })
  faux.setResponses([fauxAssistantMessage([fauxText("Thin volumes.")])])
  const agent = new ChatAgent({ models })

  const drafts: ChatMessageDraft[] = []
  await agent.run({
    model: faux.getModel(),
    reasoningEffort: "high",
    history: [],
    prompt: "Volumes?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(drafts[0]?.message.model).toBe(faux.getModel().id)
  expect(drafts[0]?.message.reasoning).toBe("high")
})

test("times each reply around the stream, not around the queue", async () => {
  // The transcript reports how long the model took. A message can wait its turn for
  // minutes before it is asked, so the clock starts when the request goes out.
  const { faux, models } = scripted()
  faux.setResponses([fauxAssistantMessage([fauxText("Thin volumes.")])])
  // A clock that stands still until the run begins: the first two readings are the
  // agent building the turn, and the pair around the stream is what gets reported.
  const readings = [1_000, 1_000, 3_500]
  const agent = new ChatAgent({ models, now: () => readings.shift() ?? 3_500 })

  const drafts: ChatMessageDraft[] = []
  await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Volumes?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(drafts[0]?.message.elapsedMs).toBe(2_500)
  // Nothing was thought, so nothing is claimed to have been.
  expect(drafts[0]?.message.thinkingMs).toBeNull()
})

test("reports how much of a reply went on thinking, up to its first word", async () => {
  // The transcript folds the reasoning away and labels the fold with this, so the
  // number has to mean the wait before the answer rather than the whole call.
  const { faux, models } = scripted({ reasoning: true })
  faux.setResponses([fauxAssistantMessage([fauxThinking("weighing the tape"), fauxText("Thin volumes.")])])
  // Asked, stream started, first word, stream finished.
  const readings = [1_000, 1_000, 2_800, 3_500]
  const agent = new ChatAgent({ models, now: () => readings.shift() ?? 3_500 })

  const drafts: ChatMessageDraft[] = []
  await agent.run({
    model: faux.getModel(),
    history: [],
    prompt: "Volumes?",
    events: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onRetry: ignoreRetry,
      onMessage: async (draft) => {
        drafts.push(draft)
      },
    },
  })

  expect(drafts[0]?.message.thinkingMs).toBe(1_800)
  expect(drafts[0]?.message.elapsedMs).toBe(2_500)
})
