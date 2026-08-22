import {
  isContextOverflow,
  isRecoverableLength,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Models,
  type ToolCall,
} from "@earendil-works/pi-ai"
import {
  chatMessageText,
  type ChatBlock,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatUsage,
} from "@trbot/chat/session.ts"
import { createChatDelegationContext, type ChatDelegationContext, type ChatToolRegistry } from "./tool.ts"

export const CHAT_SYSTEM_PROMPT = [
  "You are the trading desk assistant inside trbot, a terminal trading application.",
  "The user trades Borsa Istanbul equities and their VIOP futures contracts.",
  "Use the available market tools for current prices, instruments, portfolio, broker data, and news;",
  "do not claim live data is unavailable before checking the relevant tool.",
  "The VIOP universe intentionally exposes only the nearest-expiry contract for each underlying.",
  "Never construct or probe a contract code or expiry month. Use an exact symbol returned by list_instruments,",
  "or pass the underlying ticker so the tools resolve its current front month. If an out-month or rollover",
  "comparison is needed, say it is outside the available universe instead of calling a guessed symbol.",
  "Never infer or assume prices, quotes, positions, news, or other current market data from training",
  "data. Read it from a tool, clearly identify user-provided figures, or say it could not be verified.",
  "get_order_book can read either the VIOP contract book or its available underlying market book. Use target",
  "INSTRUMENT for the contract and target UNDERLYING for cash/spot, report which one you read, and never",
  "describe an underlying order book as a futures order book. Brokerage distribution, settlement analysis,",
  "and equity quotes still belong to an available cash-equity underlying. VIOP quotes use get_viop_quote.",
  "VIOP single-stock futures are leveraged contracts: long P/L moves with the futures price, short P/L",
  "moves inversely, and exposure and P/L scale by contract size and quantity. A standard single-stock",
  "contract normally represents 100 underlying shares, but corporate actions can change its multiplier;",
  "always use the live contractSize. Collateral is margin, not the purchase price or maximum possible loss.",
  "Account for leverage, basis versus spot, expiry, rollover, settlement, liquidity, and margin risk.",
  "Single-stock futures normally expire on the expiry month's last business day and physically settle;",
  "the user can close or roll before expiry. The daily base price is normally the previous normal-session",
  "settlement. The current daily price-change limit for single-stock futures is +/-10%; never calculate",
  "tradability from that percentage when get_viop_quote supplies the contract's live lowerLimit and upperLimit.",
  "For underlying BIST shares, distinguish the daily price margin from a circuit breaker: shares generally",
  "have a +/-10% daily margin from base price, while the current share circuit breaker is downward-only at",
  "-5% from its current circuit-breaker reference and leads to 10 minutes of order collection followed by",
  "2 minutes of matching. A BIST 100 fall of 6% or more from the previous close triggers the market-wide",
  "circuit breaker and temporarily halts the equity market and equity/equity-index VIOP contracts.",
  "Exchange rules can change. Before relying on a rule or threshold for a trade decision, verify it using",
  "live tool values or a current official Borsa Istanbul source and state any uncertainty.",
  "Answer in plain text for a narrow terminal panel: no markdown headers, no tables, short",
  "paragraphs. Be direct and brief — the user is reading this between quotes.",
  "A market-monitor event is an application continuation, not a message the user typed. It records",
  "what happened at trigger time, not current market data: follow its stored continuation, refresh the",
  "required market and account data, and then decide what, if anything, to say or do next.",
  "Never repeat a mutation merely because its result is delayed or unclear; refresh the relevant current state first.",
  "Stop-rule tools manage trbot's durable server-side protective exits, not broker-native resting stop orders.",
  "A triggered rule starts an exit countdown and may submit a marketable limit exit, so creating, editing, pausing, arming, or deleting one is a trading mutation.",
  "Goals continue immediately after settled turns; scheduled tasks wake this chat at fixed, dynamic, cron, or one-time times.",
].join(" ")

/** The harness message shape a store keeps so a later turn replays exactly. */
export type ChatRecord = Message

export interface ChatAgentOptions {
  /**
   * The harness, which resolves and refreshes the credential per request. Nothing
   * here handles a token: a run that outlives an access token is the harness's
   * problem to solve, and it already does.
   */
  models: Models
  tools?: ChatToolRegistry
  systemPrompt?: string
  now?: () => number
}

export interface ChatTurnEvents {
  onText(delta: string): void
  onReasoning(delta: string): void
  onToolCall(name: string): void
  /**
   * A message the turn produced, as soon as it is complete.
   *
   * A turn can produce several — a reply asking for tools, the tool results, then
   * the reply that follows — so each is handed over as it finishes rather than
   * only at the end. A run that dies part way has still persisted what it made.
   */
  onMessage(draft: ChatMessageDraft): Promise<void>
}

export interface ChatTurnOptions {
  /**
   * Which model answers this turn, and how hard it thinks.
   *
   * Per turn rather than per agent because two sessions on two different providers
   * run through the same agent, and because a session that changes its model mid
   * conversation must answer the next question with the new one.
   */
  model: Model<Api>
  reasoningEffort?: string | null
  /** The session's history, oldest first, as the records a store handed back. */
  history: ChatRecord[]
  /** What the trader just asked. */
  prompt: string
  /** Conversation that owns any durable work a tool creates. */
  chatSessionId?: string
  /** Inherited only by a delegated worker; root turns create a fresh context. */
  delegation?: ChatDelegationContext
  /** Inherited by delegated workers; root turns receive a fresh allowance. */
  notificationBudget?: { sent: number }
  /** Application event that woke this turn, when one exists. */
  automationEvent?: { label: string | null; referenceId: string | null }
  events: ChatTurnEvents
  signal?: AbortSignal
}

/**
 * A stored choice resolved into something a turn can run on.
 *
 * Named so a caller outside this package can hold one without importing the harness:
 * looking a model up is this package's job.
 */
export type ChatTurnModel = Pick<ChatTurnOptions, "model" | "reasoningEffort">

export interface ChatTurnResult {
  /** True when the turn ran to a natural end rather than being stopped. */
  completed: boolean
  aborted: boolean
  errorMessage: string | null
  /** A request with no durable output can be compacted and attempted once more safely. */
  overflowed?: boolean
}

const MAX_TRANSIENT_STREAM_RETRIES = 1

function isTransientStreamFailure(reply: AssistantMessage): boolean {
  if (reply.stopReason !== "error") return false
  const message = reply.errorMessage ?? ""
  return /WebSocket closed (?:1001|1005|1006|1011|1012|1013|1015)\b/i.test(message)
    || /WebSocket (?:idle timeout|stream closed before response\.completed)/i.test(message)
}

function hasUserVisibleReply(reply: AssistantMessage): boolean {
  return reply.content.some((block) => block.type !== "thinking")
}

/**
 * Runs one exchange with the model, tools included.
 *
 * This is a loop, not a single call: while a reply asks for tools it runs them,
 * appends their results, and asks again. A tool can itself run model work, so the
 * loop also carries nested usage back into the conversation record.
 */
export class ChatAgent {
  private readonly now: () => number

  constructor(private readonly options: ChatAgentOptions) {
    this.now = options.now ?? Date.now
  }

  async run(turn: ChatTurnOptions): Promise<ChatTurnResult> {
    const tools = this.options.tools
    const delegation = turn.delegation ?? createChatDelegationContext()
    const notificationBudget = turn.notificationBudget ?? { sent: 0 }
    const context: Context = {
      systemPrompt: this.options.systemPrompt ?? CHAT_SYSTEM_PROMPT,
      messages: [...turn.history],
    }
    const availableTools = tools?.list() ?? []
    if (availableTools.length > 0) context.tools = availableTools

    const asked: Message = { role: "user", content: turn.prompt, timestamp: this.now() }
    context.messages.push(asked)
    let toolExecuted = false
    let transientRetries = 0

    for (;;) {
      const { reply, timing } = await this.streamReply(context, turn)
      if (
        transientRetries < MAX_TRANSIENT_STREAM_RETRIES
        && !turn.signal?.aborted
        && !hasUserVisibleReply(reply)
        && isTransientStreamFailure(reply)
      ) {
        transientRetries += 1
        continue
      }
      transientRetries = 0
      const retryableOverflow = !toolExecuted && reply.content.length === 0 && (
        isContextOverflow(reply, turn.model.contextWindow) || isRecoverableLength(reply, turn.model.maxTokens)
      )
      if (retryableOverflow) {
        return {
          completed: false,
          aborted: false,
          errorMessage: reply.errorMessage ?? "The model context is full",
          overflowed: true,
        }
      }
      context.messages.push(reply)
      await turn.events.onMessage(assistantDraft(reply, turn.reasoningEffort ?? null, timing))

      if (reply.stopReason === "aborted") {
        return { completed: false, aborted: true, errorMessage: null }
      }
      if (reply.stopReason === "error") {
        return {
          completed: false,
          aborted: false,
          errorMessage: reply.errorMessage ?? "The model stopped with an error",
        }
      }

      const calls = reply.content.filter((block): block is ToolCall => block.type === "toolCall")
      if (calls.length === 0 || !tools) {
        return { completed: true, aborted: false, errorMessage: null }
      }

      for (const call of calls) {
        turn.events.onToolCall(call.name)
        toolExecuted = true
        const outcome = await tools.call(call, {
          signal: turn.signal,
          model: turn.model,
          reasoningEffort: turn.reasoningEffort,
          chatSessionId: turn.chatSessionId,
          delegation,
          notificationBudget,
          automationEvent: turn.automationEvent,
        })
        const result: Message = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: (outcome.modelBlocks ?? outcome.blocks)
            .filter((block) => block.kind === "TEXT")
            .map((block) => ({ type: "text" as const, text: block.text ?? "" })),
          details: outcome.details,
          isError: outcome.isError,
          timestamp: this.now(),
        }
        if (outcome.usage) result.usage = harnessUsage(outcome.usage)
        context.messages.push(result)
        await turn.events.onMessage(toolResultDraft(
          result,
          outcome.blocks,
          outcome.usage ?? null,
          outcome.effects,
        ))
      }
    }
  }

  /**
   * One call to the model, timed as it goes.
   *
   * The clock starts here rather than in `run` so it measures the request and nothing
   * else: a message can wait its turn for minutes, and that wait is not thinking.
   */
  private async streamReply(
    context: Context,
    turn: ChatTurnOptions,
  ): Promise<{ reply: AssistantMessage; timing: ReplyTiming }> {
    const started = this.now()
    let thought = false
    let thinkingMs: number | null = null
    const streamOptions = turn.reasoningEffort
      ? { signal: turn.signal, reasoningEffort: turn.reasoningEffort, sessionId: turn.chatSessionId }
      : { signal: turn.signal, sessionId: turn.chatSessionId }
    const events = this.options.models.stream(turn.model, context, streamOptions)
    for await (const event of events) {
      if (event.type === "text_delta") {
        // The first word is where thinking ended, whatever the model does afterwards.
        if (thought && thinkingMs === null) thinkingMs = this.now() - started
        turn.events.onText(event.delta)
      } else if (event.type === "thinking_delta") {
        thought = true
        turn.events.onReasoning(event.delta)
      }
    }
    // The final message carries the failure too, so it is read rather than
    // thrown: a reply that errored part way still has content worth keeping.
    const reply = await events.result()
    const elapsedMs = this.now() - started
    // A reply that thought and then said nothing — a tool call, or a run that was
    // stopped — spent the whole call thinking.
    return { reply, timing: { elapsedMs, thinkingMs: thought ? thinkingMs ?? elapsedMs : null } }
  }
}

/** How long a reply took, and how much of that was spent before its first word. */
interface ReplyTiming {
  elapsedMs: number
  thinkingMs: number | null
}

function assistantDraft(reply: AssistantMessage, reasoning: string | null, timing: ReplyTiming): ChatMessageDraft {
  const blocks = reply.content.map(replyBlock)
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: "ASSISTANT",
    status: assistantStatus(reply),
    text: chatMessageText(blocks),
    blocks,
    toolName: null,
    toolCallId: null,
    isError: reply.stopReason === "error",
    errorMessage: reply.errorMessage ?? null,
    usage: usageOf(reply),
    model: reply.responseModel ?? reply.model,
    reasoning,
    elapsedMs: timing.elapsedMs,
    thinkingMs: timing.thinkingMs,
    createdAt: reply.timestamp,
  }
  return { message, record: reply }
}

function toolResultDraft(
  result: Message & { role: "toolResult" },
  blocks: ChatBlock[],
  usage: ChatUsage | null,
  effects?: ChatMessageDraft["effects"],
): ChatMessageDraft {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: "TOOL_RESULT",
    status: result.isError ? "FAILED" : "COMPLETE",
    text: chatMessageText(blocks),
    blocks,
    toolName: result.toolName,
    toolCallId: result.toolCallId,
    isError: result.isError,
    errorMessage: null,
    usage,
    model: null,
    reasoning: null,
    elapsedMs: null,
    thinkingMs: null,
    createdAt: result.timestamp,
  }
  return { message, record: result, effects }
}

function assistantStatus(reply: AssistantMessage): ChatMessage["status"] {
  if (reply.stopReason === "error") return "FAILED"
  // Stopped part way, or cut off by the model's own limit: kept either way, and
  // named so a transcript can say the answer is not the whole answer.
  if (reply.stopReason === "aborted" || reply.stopReason === "length") return "PARTIAL"
  return "COMPLETE"
}

function replyBlock(block: AssistantMessage["content"][number]): ChatBlock {
  if (block.type === "text") {
    return { kind: "TEXT", text: block.text, toolName: null, toolCallId: null, toolArguments: null }
  }
  if (block.type === "thinking") {
    return { kind: "THINKING", text: block.thinking, toolName: null, toolCallId: null, toolArguments: null }
  }
  return {
    kind: "TOOL_CALL",
    text: null,
    toolName: block.name,
    toolCallId: block.id,
    toolArguments: block.arguments,
  }
}

function usageOf(reply: AssistantMessage): ChatUsage {
  return {
    inputTokens: reply.usage.input,
    outputTokens: reply.usage.output,
    totalTokens: reply.usage.totalTokens,
    costTotal: reply.usage.cost.total,
  }
}

function harnessUsage(usage: ChatUsage): AssistantMessage["usage"] {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.costTotal,
    },
  }
}
