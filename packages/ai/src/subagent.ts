import { Type, type Api, type Model, type Models } from "@earendil-works/pi-ai"
import type { ChatMessageDraft, ChatRetryStatus, ChatUsage } from "@trbot/chat/session.ts"
import { ChatAgent } from "./chat.ts"
import {
  createChatDelegationContext,
  externalToolEffect,
  toolText,
  type ChatDelegationContext,
  type ChatTool,
  type ChatToolRegistry,
} from "./tool.ts"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const MAX_SUBAGENTS_PER_TURN = 8
const MAX_SUBAGENT_DEPTH = 1
const PER_TASK_OUTPUT_CAP = 50 * 1_024

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke. Available agent: "worker".' }),
  task: Type.String({ description: "Task to delegate to the agent", minLength: 1, maxLength: 10_000 }),
})

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke. Available agent: "worker".' }),
  task: Type.String({
    description: "Task with an optional {previous} placeholder for the prior step's output",
    minLength: 1,
    maxLength: 10_000,
  }),
})

const SubagentParameters = Type.Object({
  agent: Type.Optional(Type.String({
    description: 'Single mode only. Set to "worker"; omit when using tasks or chain.',
  })),
  task: Type.Optional(Type.String({
    description: "Single mode only. Omit when using tasks or chain.",
    minLength: 1,
    maxLength: 10_000,
  })),
  tasks: Type.Optional(Type.Array(TaskItem, {
    description: "Parallel mode only. Omit top-level agent, task, and chain.",
  })),
  chain: Type.Optional(Type.Array(ChainItem, {
    description: "Chain mode only. Omit top-level agent, task, and tasks.",
  })),
})

const WORKER_PROMPT = [
  "You are a general-purpose subagent working in an isolated context.",
  "Complete only the delegated task and return a clear, self-contained result to the parent agent.",
  "Use any available tool when it helps. Do not delegate or create further subagents.",
  "Do not create or manage chat goals or scheduled loops; the parent agent owns chat-level automation.",
  "When using web sources, include the URLs you relied on.",
].join(" ")

type SubagentMode = "single" | "parallel" | "chain"

interface SubagentResult {
  agent: string
  task: string
  sessionId: string | null
  answer: string
  error: string | null
  usage: ChatUsage | null
  step?: number
}

interface SubagentDetails {
  mode: SubagentMode
  results: SubagentResult[]
}

export interface SubagentSessionRun {
  sessionId: string
  onText(delta: string): void
  onReasoning(delta: string): void
  onToolCall(name: string): void
  onRetry(status: ChatRetryStatus | null): void
  onMessage(draft: ChatMessageDraft): Promise<void>
  finish(error: string | null): Promise<void>
}

export interface SubagentSessionRecorder {
  start(input: {
    parentSessionId: string
    parentToolCallId: string | null
    agent: string
    task: string
    providerId: string
    modelId: string
    reasoning: string | null
  }): Promise<SubagentSessionRun>
}

/** Pi-style isolated delegation with single, bounded-parallel, and chained execution. */
export function subagentTool(
  models: Models,
  tools: ChatToolRegistry,
  sessions?: SubagentSessionRecorder,
): ChatTool<typeof SubagentParameters> {
  return {
    definition: {
      name: "subagent",
      description: [
        "Delegate work to a full-capability worker in an isolated context.",
        "Choose exactly one mode; never mix fields from different modes.",
        'Single: use only {"agent":"worker","task":"..."}; omit tasks and chain.',
        'Parallel: use only {"tasks":[{"agent":"worker","task":"..."}]}; omit top-level agent, task, and chain.',
        'Chain: use only {"chain":[{"agent":"worker","task":"..."}]}; omit top-level agent, task, and tasks. Use {previous} to include the prior step\'s output.',
        `Parallel mode accepts at most ${MAX_PARALLEL_TASKS} tasks and runs ${MAX_CONCURRENCY} at once.`,
        `One chat turn can create at most ${MAX_SUBAGENTS_PER_TURN} workers. Only the user-facing agent can delegate; workers cannot create further subagents.`,
        "If a limit is reached, the tool reports it so you can continue without delegating; the worker budget resets on the next user or application turn.",
        'The available agent is "worker".',
      ].join(" "),
      parameters: SubagentParameters,
    },
    run: async (params, options) => {
      if (!options.model) throw new Error("The active chat model was not available to the subagent")

      const hasChain = (params.chain?.length ?? 0) > 0
      const hasTasks = (params.tasks?.length ?? 0) > 0
      const hasSingle = Boolean(params.agent && params.task)
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle)
      if (modeCount !== 1) return invalidModeOutcome()
      if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
        return {
          blocks: [toolText(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`)],
          details: { mode: "parallel", results: [] } satisfies SubagentDetails,
          isError: true,
        }
      }

      const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single"
      const requestedWorkers = mode === "chain"
        ? params.chain!.length
        : mode === "parallel"
          ? params.tasks!.length
          : 1
      const delegation = options.delegation ?? createChatDelegationContext()
      const limitError = reserveSubagents(delegation, requestedWorkers)
      if (limitError) return limitOutcome(mode, limitError)

      const runOptions: RunTaskOptions = {
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        signal: options.signal,
        chatSessionId: options.chatSessionId,
        parentToolCallId: options.toolCallId,
        notificationBudget: options.notificationBudget ?? { sent: 0 },
        automationEvent: options.automationEvent,
        delegation: {
          depth: delegation.depth + 1,
          budget: delegation.budget,
        },
      }

      if (params.chain?.length) {
        return runChain(models, tools, params.chain, runOptions, sessions)
      }

      if (params.tasks?.length) {
        return runParallel(models, tools, params.tasks, runOptions, sessions)
      }

      return runSingle(models, tools, params.agent ?? "", params.task ?? "", runOptions, sessions)
    },
  }
}

interface RunTaskOptions {
  model: Model<Api>
  reasoningEffort?: string | null
  signal?: AbortSignal
  chatSessionId?: string
  parentToolCallId?: string
  notificationBudget: { sent: number }
  automationEvent?: { label: string | null; referenceId: string | null }
  delegation: ChatDelegationContext
}

async function runSingle(
  models: Models,
  tools: ChatToolRegistry,
  agentName: string,
  task: string,
  options: RunTaskOptions,
  sessions?: SubagentSessionRecorder,
) {
  const result = await runTask(models, tools, agentName, task, options, undefined, sessions)
  const text = result.error ? `Agent failed: ${result.error}` : result.answer || "(no output)"
  return {
    blocks: [toolText(result.error ? text : `Subagent ${agentName} completed.`)],
    modelBlocks: [toolText(text)],
    details: { mode: "single", results: [result] } satisfies SubagentDetails,
    isError: result.error !== null,
    usage: result.usage ?? undefined,
    ...delegatedEffects([result]),
  }
}

async function runParallel(
  models: Models,
  tools: ChatToolRegistry,
  tasks: Array<{ agent: string; task: string }>,
  options: RunTaskOptions,
  sessions?: SubagentSessionRecorder,
) {
  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, (item) => (
    runTask(models, tools, item.agent, item.task, options, undefined, sessions)
  ))
  const successes = results.filter((result) => result.error === null).length
  const summaries = results.map((result) => {
    const status = result.error ? "failed" : "completed"
    const output = truncateOutput((result.error ?? result.answer) || "(no output)")
    return `### [${result.agent}] ${status}\n\n${output}`
  })
  return {
    blocks: [toolText(`Parallel: ${successes}/${results.length} succeeded`)],
    modelBlocks: [toolText(`Parallel: ${successes}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`)],
    details: { mode: "parallel", results } satisfies SubagentDetails,
    isError: false,
    usage: combinedUsage(results),
    ...delegatedEffects(results),
  }
}

async function runChain(
  models: Models,
  tools: ChatToolRegistry,
  chain: Array<{ agent: string; task: string }>,
  options: RunTaskOptions,
  sessions?: SubagentSessionRecorder,
) {
  const results: SubagentResult[] = []
  let previous = ""

  for (let index = 0; index < chain.length; index++) {
    const item = chain[index]
    const task = item.task.replaceAll("{previous}", previous)
    const result = await runTask(models, tools, item.agent, task, options, index + 1, sessions)
    results.push(result)
    if (result.error) {
      const text = `Chain stopped at step ${index + 1} (${item.agent}): ${result.error}`
      return {
        blocks: [toolText(text)],
        modelBlocks: [toolText(text)],
        details: { mode: "chain", results } satisfies SubagentDetails,
        isError: true,
        usage: combinedUsage(results),
        ...delegatedEffects(results),
      }
    }
    previous = result.answer
  }

  return {
    blocks: [toolText(`Chain completed ${results.length} step${results.length === 1 ? "" : "s"}.`)],
    modelBlocks: [toolText(previous || "(no output)")],
    details: { mode: "chain", results } satisfies SubagentDetails,
    isError: false,
    usage: combinedUsage(results),
    ...delegatedEffects(results),
  }
}

async function runTask(
  models: Models,
  tools: ChatToolRegistry,
  agentName: string,
  task: string,
  options: RunTaskOptions,
  step?: number,
  sessions?: SubagentSessionRecorder,
): Promise<SubagentResult> {
  const stepResult = step === undefined ? {} : { step }
  if (agentName !== "worker") {
    return {
      agent: agentName,
      task,
      sessionId: null,
      answer: "",
      error: `Unknown agent: "${agentName}". Available agent: "worker".`,
      usage: null,
      ...stepResult,
    }
  }

  const drafts: ChatMessageDraft[] = []
  const session = sessions && options.chatSessionId
    ? await sessions.start({
        parentSessionId: options.chatSessionId,
        parentToolCallId: options.parentToolCallId ?? null,
        agent: agentName,
        task,
        providerId: options.model.provider,
        modelId: options.model.id,
        reasoning: options.reasoningEffort ?? null,
      })
    : null
  const agent = new ChatAgent({ models, tools: workerTools(tools), systemPrompt: WORKER_PROMPT })
  let taskResult: SubagentResult
  try {
    const result = await agent.run({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      history: [],
      prompt: task,
      chatSessionId: session?.sessionId ?? options.chatSessionId,
      delegation: options.delegation,
      notificationBudget: options.notificationBudget,
      automationEvent: options.automationEvent,
      signal: options.signal,
      events: {
        onText: (delta) => session?.onText(delta),
        onReasoning: (delta) => session?.onReasoning(delta),
        onToolCall: (name) => session?.onToolCall(name),
        onRetry: (status) => session?.onRetry(status),
        onMessage: async (draft) => {
          drafts.push(draft)
          await session?.onMessage(draft)
        },
      },
    })
    const answer = drafts
      .filter((draft) => draft.message.role === "ASSISTANT" && draft.message.text.trim())
      .at(-1)?.message.text.trim() ?? ""
    const error = result.errorMessage ?? (result.aborted ? "Stopped" : answer ? null : "No answer returned")
    taskResult = {
      agent: agentName,
      task,
      sessionId: session?.sessionId ?? null,
      answer,
      error,
      usage: draftUsage(drafts),
      ...stepResult,
    }
  } catch (error) {
    taskResult = {
      agent: agentName,
      task,
      sessionId: session?.sessionId ?? null,
      answer: "",
      error: error instanceof Error ? error.message : String(error),
      usage: draftUsage(drafts),
      ...stepResult,
    }
  }
  await session?.finish(taskResult.error)
  return taskResult
}

function reserveSubagents(context: ChatDelegationContext, requested: number): string | null {
  if (context.depth >= MAX_SUBAGENT_DEPTH) {
    const unit = MAX_SUBAGENT_DEPTH === 1 ? "level" : "levels"
    return `Subagent nesting limit reached (${MAX_SUBAGENT_DEPTH} ${unit}). Continue the task yourself using the available tools.`
  }
  const remaining = MAX_SUBAGENTS_PER_TURN - context.budget.created
  if (requested > remaining) {
    return `Subagent limit reached: ${MAX_SUBAGENTS_PER_TURN} workers are allowed per chat turn, ${context.budget.created} have already been allocated, and this call requested ${requested}. Continue with existing results or do the remaining work yourself. The worker budget resets on the next user or application turn.`
  }
  context.budget.created += requested
  return null
}

/** Give a worker every parent capability except the ability to delegate again. */
function workerTools(tools: ChatToolRegistry): ChatToolRegistry {
  return {
    list: () => tools.list().filter((tool) => tool.name !== "subagent"),
    call: (call, options) => {
      if (call.name !== "subagent") return tools.call(call, options)
      return Promise.resolve({
        blocks: [toolText("Workers cannot create further subagents. Continue the delegated task using the available tools.")],
        details: null,
        isError: true,
      })
    },
  }
}

function limitOutcome(mode: SubagentMode, message: string) {
  return {
    blocks: [toolText(message)],
    details: { mode, results: [] } satisfies SubagentDetails,
    isError: true,
  }
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from<TOutput>({ length: items.length })
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function truncateOutput(output: string): string {
  const encoded = new TextEncoder().encode(output)
  if (encoded.byteLength <= PER_TASK_OUTPUT_CAP) return output
  const truncated = new TextDecoder().decode(encoded.slice(0, PER_TASK_OUTPUT_CAP))
  return `${truncated}\n\n[Output truncated: ${encoded.byteLength - PER_TASK_OUTPUT_CAP} bytes omitted. Full output preserved in tool details.]`
}

function invalidModeOutcome() {
  return {
    blocks: [toolText('Invalid parameters. Provide exactly one mode. Available agent: "worker".')],
    details: { mode: "single", results: [] } satisfies SubagentDetails,
    isError: true,
  }
}

function delegatedEffects(results: SubagentResult[]) {
  const count = results.filter((result) => result.sessionId !== null).length
  if (count === 0) return {}
  return {
    effects: [externalToolEffect(
      `${count} delegated worker${count === 1 ? " and its transcript remain" : "s and their transcripts remain"}`,
    )],
  }
}

function draftUsage(drafts: ChatMessageDraft[]): ChatUsage | null {
  return sumUsage(drafts.map((draft) => draft.message.usage))
}

function combinedUsage(results: SubagentResult[]): ChatUsage | undefined {
  return sumUsage(results.map((result) => result.usage)) ?? undefined
}

function sumUsage(values: Array<ChatUsage | null>): ChatUsage | null {
  let total: ChatUsage | null = null
  for (const usage of values) {
    if (!usage) continue
    total ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 }
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.totalTokens += usage.totalTokens
    total.costTotal += usage.costTotal
  }
  return total
}
