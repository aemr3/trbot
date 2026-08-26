import type { Api, Message, Model, Models, ToolCall } from "@earendil-works/pi-ai"
import type {
  ChatCompaction,
  ChatContextRecord,
  ChatModelContext,
} from "@trbot/chat/session.ts"
import type { ChatRecord } from "./chat.ts"

export const CHAT_COMPACTION_RESERVE_TOKENS = 16_384
export const CHAT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
const TOOL_RESULT_MAX_CHARS = 2_000

const SUMMARY_SYSTEM_PROMPT = [
  "You maintain a rolling context summary for a trading assistant.",
  "Summarize only the supplied history. Never answer it or invent current market facts.",
  "Preserve exact instrument symbols, quantities, prices, timestamps, monitor levels, decisions,",
  "user instructions, risk constraints, pending questions, and relevant tool results.",
  "Treat market values as historical observations unless the source explicitly says otherwise.",
  "Return only the requested structure in concise plain text.",
].join(" ")

const SUMMARY_TEMPLATE = `Objective:
- ...

User preferences and constraints:
- ...

Positions and instruments:
- ...

Verified market context:
- ...

Active monitors:
- ...

Decisions and risk levels:
- ...

Completed:
- ...

Pending:
- ...

Next step:
- ...`

export interface ChatCompactionInput {
  sessionId: string
  model: Model<Api>
  context: ChatModelContext
  prompt: string
  signal?: AbortSignal
  force?: boolean
}

export interface ChatCompactionResult {
  checkpoint: ChatCompaction
  history: ChatRecord[]
}

export interface ChatCompactionRunner {
  compact(input: ChatCompactionInput): Promise<ChatCompactionResult | null>
  history(context: ChatModelContext): ChatRecord[]
}

export interface ChatCompactorOptions {
  models: Models
  now?: () => number
  reserveTokens?: number
  keepRecentTokens?: number
}

/** Creates hidden rolling summaries while leaving the durable transcript intact. */
export class ChatCompactor implements ChatCompactionRunner {
  private readonly now: () => number
  private readonly reserveTokens: number
  private readonly keepRecentTokens: number

  constructor(private readonly options: ChatCompactorOptions) {
    this.now = options.now ?? Date.now
    this.reserveTokens = options.reserveTokens ?? CHAT_COMPACTION_RESERVE_TOKENS
    this.keepRecentTokens = options.keepRecentTokens ?? CHAT_COMPACTION_KEEP_RECENT_TOKENS
  }

  history(context: ChatModelContext): ChatRecord[] {
    return [
      ...(context.compaction ? [summaryRecord(context.compaction)] : []),
      ...context.records.map((entry) => modelRecord(entry.record)),
    ]
  }

  async compact(input: ChatCompactionInput): Promise<ChatCompactionResult | null> {
    const history = this.history(input.context)
    const estimatedTokens = history.reduce((total, message) => total + estimateMessageTokens(message), 0)
    const measuredTokens = measuredContextTokens(input)
    const tokensBefore = measuredTokens ?? estimatedTokens
    const threshold = input.model.contextWindow - this.reserveTokens
    if (!input.force && tokensBefore <= threshold) return null

    // Overflow recovery is the last bounded attempt, so replace the complete
    // active prefix rather than preserving the normal verbatim tail again.
    const split = selectRecentTurns(input.context.records, input.force ? 0 : this.keepRecentTokens)
    if (split <= 0) return null
    const head = input.context.records.slice(0, split)
    const tail = input.context.records.slice(split)
    const summary = await this.generateSummary({
      model: input.model,
      previous: input.context.compaction?.summary,
      records: head,
      signal: input.signal,
    })
    if (!summary) return null

    const createdAt = this.now()
    const baseCheckpoint: ChatCompaction = {
      sessionId: input.sessionId,
      summary,
      compactedThroughSeq: head.at(-1)!.seq,
      firstKeptSeq: tail[0]?.seq ?? null,
      tokensBefore,
      tokensAfter: 0,
      createdAt,
    }
    const compactedHistory = [summaryRecord(baseCheckpoint), ...tail.map((entry) => modelRecord(entry.record))]
    const tokensAfter = compactedHistory.reduce((total, message) => total + estimateMessageTokens(message), 0)
    const checkpoint: ChatCompaction = { ...baseCheckpoint, tokensAfter }
    return {
      checkpoint,
      history: [summaryRecord(checkpoint), ...tail.map((entry) => modelRecord(entry.record))],
    }
  }

  private async generateSummary(input: {
    model: Model<Api>
    previous?: string
    records: ChatContextRecord[]
    signal?: AbortSignal
  }): Promise<string | null> {
    const conversation = input.records
      .map((entry) => serializeRecord(modelRecord(entry.record)))
      .filter(Boolean)
      .join("\n\n")
    const previous = input.previous
      ? `Previous rolling summary:\n<previous-summary>\n${input.previous}\n</previous-summary>\n\n`
      : ""
    const prompt = [
      previous,
      `History to merge:\n<conversation>\n${conversation}\n</conversation>`,
      "Produce an updated summary. Carry forward still-relevant facts from the previous summary; newer history wins when facts conflict.",
      SUMMARY_TEMPLATE,
    ].filter(Boolean).join("\n\n")
    const response = await this.options.models.completeSimple(input.model, {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [userRecord(prompt, this.now())],
    }, {
      signal: input.signal,
      maxTokens: Math.min(Math.floor(this.reserveTokens * 0.8), input.model.maxTokens),
      cacheRetention: "none",
    })
    if (response.stopReason === "aborted") return null
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Chat compaction failed")
    }
    if (response.stopReason === "length") {
      throw new Error("Chat compaction failed: generation hit the token cap and the summary is incomplete")
    }
    if (response.content.some((block) => block.type === "toolCall")) {
      throw new Error("Chat compaction attempted to call a tool")
    }
    const summary = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim()
    return summary || null
  }
}

/** Keeps the newest complete turns inside the verbatim tail. */
export function selectRecentTurns(records: readonly ChatContextRecord[], keepTokens: number): number {
  const starts = records.flatMap((entry, index) => (
    modelRecord(entry.record).role === "user" ? [index] : []
  ))
  if (starts.length === 0) return records.length

  let keptTokens = 0
  let keepFrom = records.length
  for (let turn = starts.length - 1; turn >= 0; turn--) {
    const start = starts[turn]!
    const end = starts[turn + 1] ?? records.length
    const turnTokens = records
      .slice(start, end)
      .reduce((total, entry) => total + estimateMessageTokens(modelRecord(entry.record)), 0)
    if (keptTokens + turnTokens > keepTokens) break
    keptTokens += turnTokens
    keepFrom = start
  }
  return keepFrom
}

/** Pi's context estimate starts at the last valid provider usage, then adds trailing messages. */
function measuredContextTokens(input: ChatCompactionInput): number | null {
  const records = input.context.records.map((entry) => modelRecord(entry.record))
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const message = records[index]
    if (
      message?.role !== "assistant"
      || message.stopReason === "error"
      || message.stopReason === "aborted"
    ) continue
    if (input.context.compaction && message.timestamp <= input.context.compaction.createdAt) continue
    const usageTokens = message.usage.totalTokens || (
      message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
    )
    if (usageTokens <= 0) continue
    const trailingTokens = records
      .slice(index + 1)
      .reduce((total, record) => total + estimateMessageTokens(record), 0)
    return usageTokens + trailingTokens
  }
  return null
}

function estimateMessageTokens(message: Message): number {
  if (message.role === "user" || message.role === "toolResult") {
    const text = Array.isArray(message.content)
      ? message.content.map((block) => block.type === "text" ? block.text : "[image]").join("")
      : message.content
    return estimateTextTokens(text)
  }
  return estimateTextTokens(message.content.map((block) => {
    if (block.type === "text") return block.text
    if (block.type === "thinking") return block.thinking
    return `${block.name}${safeJson(block.arguments)}`
  }).join(""))
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function serializeRecord(message: ChatRecord): string {
  if (message.role === "user") {
    const content = Array.isArray(message.content)
      ? message.content.map((block) => block.type === "text" ? block.text : "[Attached image]").join("\n")
      : message.content
    return `[User]: ${content}`
  }
  if (message.role === "toolResult") {
    const content = message.content
      .map((block) => block.type === "text" ? block.text : "[Attached image]")
      .join("\n")
    return `[Tool result: ${message.toolName}]: ${truncate(content)}`
  }
  return message.content.flatMap((block) => {
    if (block.type === "thinking") return block.thinking ? [`[Assistant reasoning]: ${block.thinking}`] : []
    if (block.type === "text") return block.text ? [`[Assistant]: ${block.text}`] : []
    return [`[Assistant tool call]: ${block.name}(${safeJson(block.arguments)})`]
  }).join("\n")
}

function truncate(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[${text.length - TOOL_RESULT_MAX_CHARS} characters omitted]`
}

function summaryRecord(compaction: ChatCompaction): ChatRecord {
  return userRecord(
    `<conversation-summary>\n${compaction.summary}\n</conversation-summary>\nContinue from this summary and the recent messages that follow it.`,
    compaction.createdAt,
  )
}

function userRecord(content: string, timestamp: number): ChatRecord {
  return { role: "user", content, timestamp }
}

function safeJson(value: ToolCall["arguments"]): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

/** Restores the harness-owned message that ChatContextRecord stores opaquely. */
export function modelRecord(record: ChatContextRecord["record"]): ChatRecord {
  // SAFETY: Chat context records are written only from harness ChatRecord values
  // and are replayed unchanged; the chat domain keeps the field opaque to avoid
  // depending on a model-provider package.
  return record as ChatRecord
}
