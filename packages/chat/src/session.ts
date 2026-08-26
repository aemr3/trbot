// What a chat is, as both the server and a client understand it. Nothing here
// knows about HTTP, the database, the terminal, or the model harness — a client
// renders these shapes and the server stores them.
import { z } from "zod"

export type ChatRole = "USER" | "APP_EVENT" | "ASSISTANT" | "TOOL_RESULT"

/** Maximum number of top-level events the terminal keeps materialized. */
export const CHAT_TIMELINE_LIMIT = 100

/**
 * Where a message stands.
 *
 * `QUEUED` and `SENT` describe an input, whether it came from the trader or the
 * application: it waits its turn and is marked sent once that turn has run. The
 * rest describe a reply — `PARTIAL` is an answer that was stopped part way and kept.
 */
export type ChatMessageStatus = "QUEUED" | "SENT" | "COMPLETE" | "PARTIAL" | "FAILED"

export type ChatBlockKind = "TEXT" | "THINKING" | "TOOL_CALL" | "IMAGE"

/**
 * One piece of a message.
 *
 * Tool and image kinds are part of the contract from the start even though
 * nothing produces them yet: a client that already knows how to skip a block it
 * does not render needs no protocol change on the day tools are turned on.
 */
export interface ChatBlock {
  kind: ChatBlockKind
  text: string | null
  toolName: string | null
  toolCallId: string | null
  toolArguments: unknown
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Zero for a subscription call, which is not billed per token. */
  costTotal: number
}

export interface ChatMessage {
  id: string
  /** Durable conversation order; absent on frames from older servers. */
  seq?: number
  role: ChatRole
  status: ChatMessageStatus
  /** The readable text of the message, which is what a transcript shows. */
  text: string
  blocks: ChatBlock[]
  /** Set on a tool result, naming the call it answers. */
  toolName: string | null
  toolCallId: string | null
  isError: boolean
  errorMessage: string | null
  usage: ChatUsage | null
  /**
   * Which model wrote this reply, and how hard it was thinking.
   *
   * Recorded per message rather than read from the session, because a session can be
   * pointed at another model: a transcript that took its labels from the session would
   * relabel every past reply and claim a model wrote words it never saw. Null on a
   * trader's message, and on a reply stored before either was recorded.
   */
  model: string | null
  reasoning: string | null
  /**
   * How long the model took to produce this reply, in milliseconds.
   *
   * Measured around the stream rather than derived from timestamps, because a message
   * that waited in the queue was written long before it was asked: the difference
   * between two `createdAt` would report the wait as thinking. Null on a trader's
   * message, and on a reply stored before it was measured.
   */
  elapsedMs: number | null
  /**
   * How much of that went on thinking, in milliseconds: the wait before the first word.
   *
   * Null when the model did not think, or did not report it. Kept apart from
   * `elapsedMs` because the two answer different questions — how long the trader waited,
   * and how much of the wait bought reasoning.
   */
  thinkingMs: number | null
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  /** Null for a trader chat; set for an isolated worker spawned from another session. */
  parentSessionId: string | null
  /** The parent prompt whose turn created this worker. Null for roots and legacy workers. */
  parentPromptMessageId: string | null
  /** The exact parent tool call that created this worker. Null for roots and legacy workers. */
  parentToolCallId: string | null
  /** The delegated agent name for a child session. Null on trader chats. */
  agent: string | null
  /**
   * Which model answers this session, and how hard it thinks.
   *
   * Recorded per session, not read from a setting at send time, so a transcript
   * still says what wrote it after the default changes — and so two sessions can
   * run on two different providers at once. Null on a session written before
   * either was chosen; such a session takes the current default when it next runs.
   */
  model: string
  provider: string | null
  reasoning: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  /** How many messages are waiting their turn. */
  queued: number
  /** Whether a reply is being generated right now. */
  running: boolean
}

/** A reply as it is being generated, for a client that arrives mid-run. */
export interface ChatPartial {
  runId: string
  /** Deltas counted so far, so a client can tell whether it missed one. */
  seq: number
  text: string
  reasoning: string
}

export interface ChatSessionDetail {
  session: ChatSession
  messages: ChatMessage[]
  partial: ChatPartial | null
  /** The current model-context checkpoint; optional while older servers are supported. */
  compaction?: ChatCompaction | null
}

export const ChatCompactionSchema: z.ZodType<ChatCompaction> = z.object({
  sessionId: z.string(),
  summary: z.string(),
  compactedThroughSeq: z.number().int(),
  firstKeptSeq: z.number().int().nullable(),
  tokensBefore: z.number().int(),
  tokensAfter: z.number().int().nullable(),
  createdAt: z.number(),
})

export const CHAT_TOOL_EFFECT_KINDS = [
  "MARKET_MONITOR",
  "STOP_RULE",
  "CHAT_GOAL",
  "CHAT_LOOP",
  "CHAT_NOTIFICATION",
  "EXTERNAL",
] as const

export type ChatToolEffectKind = (typeof CHAT_TOOL_EFFECT_KINDS)[number]

/**
 * A successful tool mutation recorded beside its result.
 *
 * Application-owned resources keep before/after snapshots so rewind can restore
 * them safely. External effects deliberately carry no rollback payload.
 */
export interface ChatToolEffect {
  kind: ChatToolEffectKind
  resourceId: string | null
  description: string
  reversible: boolean
  before: unknown | null
  after: unknown | null
}

/** The safe, client-facing part of one tool effect in a rewind preview. */
export interface ChatUndoEffect {
  description: string
  reversible: boolean
}

export interface ChatUndoPreview {
  prompt: string
  effects: ChatUndoEffect[]
}

/** What a conversation undo removed, restored, and preserved. */
export interface ChatUndoResult {
  prompt: string
  removedMessageIds: string[]
  revertedEffects: string[]
  preservedEffects: string[]
}

export const ChatRoleSchema = z.enum(["USER", "APP_EVENT", "ASSISTANT", "TOOL_RESULT"])
export const ChatMessageStatusSchema = z.enum(["QUEUED", "SENT", "COMPLETE", "PARTIAL", "FAILED"])
export const ChatBlockKindSchema = z.enum(["TEXT", "THINKING", "TOOL_CALL", "IMAGE"])

const ChatBlockSchema: z.ZodType<ChatBlock> = z.object({
  kind: ChatBlockKindSchema,
  text: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  toolArguments: z.unknown(),
})

const ChatUsageSchema: z.ZodType<ChatUsage> = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costTotal: z.number(),
})

export const ChatMessageSchema: z.ZodType<ChatMessage> = z.object({
  id: z.string(),
  seq: z.number().int().optional(),
  role: ChatRoleSchema,
  status: ChatMessageStatusSchema,
  text: z.string(),
  blocks: z.array(ChatBlockSchema),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  isError: z.boolean(),
  errorMessage: z.string().nullable(),
  usage: ChatUsageSchema.nullable(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  elapsedMs: z.number().nullable(),
  thinkingMs: z.number().nullable(),
  createdAt: z.number(),
})

export const ChatSessionSchema: z.ZodType<ChatSession> = z.object({
  id: z.string(),
  title: z.string(),
  parentSessionId: z.string().nullable(),
  parentPromptMessageId: z.string().nullable().default(null),
  parentToolCallId: z.string().nullable().default(null),
  agent: z.string().nullable(),
  model: z.string(),
  provider: z.string().nullable(),
  reasoning: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  queued: z.number(),
  running: z.boolean(),
})

const ChatPartialSchema: z.ZodType<ChatPartial> = z.object({
  runId: z.string(),
  seq: z.number(),
  text: z.string(),
  reasoning: z.string(),
})

export const ChatSessionDetailSchema: z.ZodType<ChatSessionDetail> = z.object({
  session: ChatSessionSchema,
  messages: z.array(ChatMessageSchema),
  partial: ChatPartialSchema.nullable(),
  compaction: z.lazy(() => ChatCompactionSchema).nullable().optional(),
})

export const ChatToolEffectSchema: z.ZodType<ChatToolEffect> = z.object({
  kind: z.enum(CHAT_TOOL_EFFECT_KINDS),
  resourceId: z.string().nullable(),
  description: z.string().min(1),
  reversible: z.boolean(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
})

export const ChatUndoEffectSchema: z.ZodType<ChatUndoEffect> = z.object({
  description: z.string(),
  reversible: z.boolean(),
})

export const ChatUndoPreviewSchema: z.ZodType<ChatUndoPreview> = z.object({
  prompt: z.string(),
  effects: z.array(ChatUndoEffectSchema),
})

export const ChatUndoResultSchema: z.ZodType<ChatUndoResult> = z.object({
  prompt: z.string(),
  removedMessageIds: z.array(z.string()),
  revertedEffects: z.array(z.string()),
  preservedEffects: z.array(z.string()),
})

export const ChatUndoInputSchema = z.object({
  messageId: z.string().min(1),
  revertEffects: z.boolean().optional().default(false),
})

export const ChatUndoPreviewInputSchema = z.object({
  messageId: z.string().min(1),
})

export const ChatTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(CHAT_TIMELINE_LIMIT).optional(),
})

export const ChatMessageInputSchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0),
})

export type ChatRunStatus = "running" | "done" | "failed" | "aborted"

/**
 * A message on its way into storage. The `record` is the harness's own message,
 * kept so a later turn can replay exactly what the model produced; a store
 * writes it and no client ever sees it.
 */
export interface ChatMessageDraft {
  message: ChatMessage
  record: unknown
  /** Successful tool mutations caused by this result, never shown to the model. */
  effects?: ChatToolEffect[]
}

/** An application event that wakes a conversation exactly once. */
export interface ChatApplicationEvent {
  /** Stable across retries of the same external event. */
  key: string
  /** Compact fact shown in the transcript. */
  text: string
  /** Full event and stored continuation handed to the model. */
  prompt: string
  /** Short source label shown above the event in a transcript. */
  label?: string
  /** Stable owner id used to recover typed automation authority for this turn. */
  referenceId?: string
}

/**
 * Which model a session runs on.
 *
 * The provider is named alongside the model because the same model id can be served
 * by more than one provider — the same GPT sits behind a subscription, an API key, and
 * a gateway — and they are not interchangeable: they authenticate differently and bill
 * differently.
 */
export interface ChatModelChoice {
  providerId: string
  modelId: string
  reasoning: string | null
}

/** Hidden rolling summary used to rebuild model context without rewriting the transcript. */
export interface ChatCompaction {
  sessionId: string
  summary: string
  compactedThroughSeq: number
  firstKeptSeq: number | null
  tokensBefore: number
  /** Estimated active context after compaction; null on older checkpoints. */
  tokensAfter: number | null
  createdAt: number
}

export type ChatCompactionReport =
  | { compacted: true; tokensBefore: number; tokensAfter: number }
  | { compacted: false; tokensBefore: null }

export const ChatCompactionReportSchema: z.ZodType<ChatCompactionReport> = z.discriminatedUnion("compacted", [
  z.object({ compacted: z.literal(true), tokensBefore: z.number().int(), tokensAfter: z.number().int() }),
  z.object({ compacted: z.literal(false), tokensBefore: z.null() }),
])

/** One persisted harness record and its stable position in the complete transcript. */
export interface ChatContextRecord {
  id: string
  seq: number
  record: unknown
}

/** The active model-facing slice. The complete transcript remains available through `get`. */
export interface ChatModelContext {
  compaction: ChatCompaction | null
  records: ChatContextRecord[]
}

export interface ChatSessionStore {
  /** Trader-owned root conversations only; child sessions have their own picker. */
  list(): Promise<ChatSession[]>
  listChildren(parentSessionId: string): Promise<ChatSession[]>
  get(sessionId: string, topLevelLimit?: number): Promise<ChatSessionDetail | null>
  /** The harness records of a session's messages, in order, for replay. */
  records(sessionId: string): Promise<unknown[]>
  /** The rolling summary and verbatim tail currently used for model replay. */
  context(sessionId: string): Promise<ChatModelContext>
  /** Replaces the rolling summary without removing any visible transcript rows. */
  saveCompaction(compaction: ChatCompaction): Promise<void>
  /** Model-facing text for one queued input; application events may hide detail from the transcript. */
  inputText(messageId: string): Promise<string | null>
  create(session: ChatSession): Promise<void>
  /** A trader-chosen title is final and cannot be replaced by background generation. */
  rename(sessionId: string, title: string): Promise<void>
  /**
   * Replaces the title only when it is still the automatic title this job started from.
   *
   * The comparison makes a slow model response harmless: it cannot overwrite a
   * manual rename or a newer title job that completed first.
   */
  replaceAutomaticTitle(sessionId: string, expectedTitle: string, title: string): Promise<boolean>
  /** Points a session at a different model, from the next turn onwards. */
  configure(sessionId: string, choice: ChatModelChoice): Promise<void>
  delete(sessionId: string): Promise<void>
  append(sessionId: string, draft: ChatMessageDraft): Promise<void>
  /** Appends a retryable application event unless its key was already stored. */
  appendEvent(sessionId: string, draft: ChatMessageDraft, eventKey: string): Promise<boolean>
  update(messageId: string, draft: ChatMessageDraft): Promise<void>
  setStatus(messageId: string, status: ChatMessageStatus): Promise<void>
  /**
   * Marks a queued message as asked, and moves it to the end of the conversation.
   *
   * A message takes its place in the queue when it is written, but its place in the
   * conversation only when it is actually said. Without the move, a question queued
   * behind another would sort before the answer to that other one — and the model
   * would be replayed a conversation in an order nobody ever had.
   */
  markSent(messageId: string): Promise<void>
  remove(messageId: string): Promise<void>
  /** Tool mutations recorded at or after a prospective rewind point. */
  effectsFrom(sessionId: string, messageId: string): Promise<ChatToolEffect[]>
  /** Removes one prompt and everything after it, including hidden compacted context. */
  rewindFrom(sessionId: string, messageId: string): Promise<string[]>
  /** Sessions holding queued messages, so a restarted server resumes them. */
  queuedSessionIds(): Promise<string[]>
}

/**
 * Keeps the newest conversational events and every tool result between them.
 *
 * Tool results are separate rows, so counting raw rows would retain much less than
 * the intended number of conversational events.
 */
export function recentChatTimeline<T extends { role: string }>(messages: readonly T[], topLevelLimit: number): T[] {
  let topLevelCount = 0
  let start = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "TOOL_RESULT") continue
    topLevelCount++
    if (topLevelCount > topLevelLimit) return messages.slice(start)
    start = index
  }
  return [...messages]
}

const TITLE_LENGTH = 48
const UNTITLED = "New chat"

const DEFAULT_SESSION_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A recognizable timestamp placeholder used until background title generation finishes. */
export function defaultChatSessionTitle(createdAt: number): string {
  return `New session - ${new Date(createdAt).toISOString()}`
}

export function isDefaultChatSessionTitle(title: string): boolean {
  return DEFAULT_SESSION_TITLE.test(title)
}

/** A compact title for application-owned child sessions, which do not run title generation. */
export function chatSessionTitle(firstMessage: string): string {
  const line = firstMessage.replace(/\s+/g, " ").trim()
  if (!line) return UNTITLED
  const characters = [...line]
  if (characters.length <= TITLE_LENGTH) return line
  return `${characters.slice(0, TITLE_LENGTH - 1).join("").trimEnd()}…`
}

/** The readable text of a message, which is what a transcript and SQL show. */
export function chatMessageText(blocks: ChatBlock[]): string {
  return blocks
    .filter((block) => block.kind === "TEXT")
    .map((block) => block.text ?? "")
    .join("")
}

export function chatBlockText(text: string): ChatBlock {
  return { kind: "TEXT", text, toolName: null, toolCallId: null, toolArguments: null }
}
