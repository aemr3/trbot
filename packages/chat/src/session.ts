// What a chat is, as both the server and a client understand it. Nothing here
// knows about HTTP, the database, the terminal, or the model harness — a client
// renders these shapes and the server stores them.

export type ChatRole = "USER" | "ASSISTANT" | "TOOL_RESULT"

/**
 * Where a message stands.
 *
 * `QUEUED` and `SENT` describe something the trader wrote: a message waits its
 * turn and is marked sent once the turn it belongs to has run. The rest describe
 * a reply — `PARTIAL` is an answer that was stopped part way and kept.
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
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  model: string
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
}

export type ChatRunStatus = "running" | "done" | "failed" | "aborted"

/**
 * A message on its way into storage. The `record` is the harness's own message,
 * kept so a later turn can replay exactly what the model produced; a store
 * writes it and no client ever sees it.
 */
export interface ChatMessageDraft {
  message: ChatMessage
  record: unknown
}

export interface ChatSessionStore {
  list(): Promise<ChatSession[]>
  get(sessionId: string): Promise<ChatSessionDetail | null>
  /** The harness records of a session's messages, in order, for replay. */
  records(sessionId: string): Promise<unknown[]>
  create(session: ChatSession): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  delete(sessionId: string): Promise<void>
  append(sessionId: string, draft: ChatMessageDraft): Promise<void>
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
  /** Sessions holding queued messages, so a restarted server resumes them. */
  queuedSessionIds(): Promise<string[]>
}

// A session is named after what was first asked of it, which is the only thing
// available without spending a model call on a title.
const TITLE_LENGTH = 48
const UNTITLED = "New chat"

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
