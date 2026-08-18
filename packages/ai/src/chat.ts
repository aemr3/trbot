import {
  stream,
  type AssistantMessage,
  type Context,
  type Api,
  type Message,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai"
import {
  chatMessageText,
  type ChatBlock,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatUsage,
} from "@trbot/chat/session.ts"
import type { ChatToolRegistry } from "./tool.ts"

export const CHAT_SYSTEM_PROMPT = [
  "You are the trading desk assistant inside trbot, a terminal trading application.",
  "The trader deals Borsa Istanbul equities and their VIOP futures contracts.",
  "Answer in plain text for a narrow terminal panel: no markdown headers, no tables, short",
  "paragraphs. Be direct and brief — a trader is reading this between quotes.",
  "When you give a trade idea, name the direction, the entry, the level to take profit at, and",
  "the level that invalidates it. An idea that says where to get in but not where to get out is",
  "not an idea. Say which figures you were given and which you are assuming; never invent a",
  "price, a level, or a position the trader has not shown you.",
].join(" ")

/** The harness message shape a store keeps so a later turn replays exactly. */
export type ChatRecord = Message

export interface ChatAgentOptions {
  model: Model<Api>
  /** Read per call: an access token is refreshed underneath a long-lived agent. */
  accessToken: () => Promise<string>
  reasoningEffort?: string
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
  /** The session's history, oldest first, as the records a store handed back. */
  history: ChatRecord[]
  /** What the trader just asked. */
  prompt: string
  events: ChatTurnEvents
  signal?: AbortSignal
}

export interface ChatTurnResult {
  /** True when the turn ran to a natural end rather than being stopped. */
  completed: boolean
  aborted: boolean
  errorMessage: string | null
}

/**
 * Runs one exchange with the model, tools included.
 *
 * This is a loop, not a single call: while a reply asks for tools it runs them,
 * appends their results, and asks again. Nothing registers a tool yet, so today
 * the loop turns once — but the shape means turning tools on adds a registry
 * rather than rewriting how a turn works.
 */
export class ChatAgent {
  private readonly now: () => number

  constructor(private readonly options: ChatAgentOptions) {
    this.now = options.now ?? Date.now
  }

  async run(turn: ChatTurnOptions): Promise<ChatTurnResult> {
    const tools = this.options.tools
    const context: Context = {
      systemPrompt: this.options.systemPrompt ?? CHAT_SYSTEM_PROMPT,
      messages: [...turn.history],
      ...(tools && tools.list().length > 0 ? { tools: tools.list() } : {}),
    }

    const asked: Message = { role: "user", content: turn.prompt, timestamp: this.now() }
    context.messages.push(asked)

    const accessToken = await this.options.accessToken()

    for (;;) {
      const reply = await this.streamReply(context, accessToken, turn)
      context.messages.push(reply)
      await turn.events.onMessage(assistantDraft(reply))

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
        const outcome = await tools.call(call, { signal: turn.signal })
        const result: Message = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.blocks
            .filter((block) => block.kind === "TEXT")
            .map((block) => ({ type: "text" as const, text: block.text ?? "" })),
          details: outcome.details,
          isError: outcome.isError,
          timestamp: this.now(),
        }
        context.messages.push(result)
        await turn.events.onMessage(toolResultDraft(result, outcome.blocks))
      }
    }
  }

  private async streamReply(
    context: Context,
    accessToken: string,
    turn: ChatTurnOptions,
  ): Promise<AssistantMessage> {
    const events = stream(this.options.model, context, {
      apiKey: accessToken,
      signal: turn.signal,
      // Named for what the provider calls it; one that does not know the option
      // ignores it.
      ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
    })
    for await (const event of events) {
      if (event.type === "text_delta") turn.events.onText(event.delta)
      else if (event.type === "thinking_delta") turn.events.onReasoning(event.delta)
    }
    // The final message carries the failure too, so it is read rather than
    // thrown: a reply that errored part way still has content worth keeping.
    return await events.result()
  }
}

function assistantDraft(reply: AssistantMessage): ChatMessageDraft {
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
    createdAt: reply.timestamp,
  }
  return { message, record: reply }
}

function toolResultDraft(result: Message & { role: "toolResult" }, blocks: ChatBlock[]): ChatMessageDraft {
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
    usage: null,
    createdAt: result.timestamp,
  }
  return { message, record: result }
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
