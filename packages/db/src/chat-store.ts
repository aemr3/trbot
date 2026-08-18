import { asc, eq, inArray, max, sql } from "drizzle-orm"
import type {
  ChatBlock,
  ChatMessage,
  ChatMessageDraft,
  ChatMessageStatus,
  ChatRole,
  ChatSession,
  ChatSessionDetail,
  ChatSessionStore,
} from "@trbot/chat/session.ts"
import type { AppDatabase } from "./client.ts"
import { chatMessageBlocks, chatMessages, chatSessions } from "./schema.ts"

/**
 * Chat sessions in SQLite.
 *
 * The columns mirror the model harness's own message rather than summarising it,
 * because replaying a session means handing the model back exactly what it
 * produced. So this file has two jobs that must agree: writing a harness message
 * into rows, and rebuilding that same message from them. `chat-store.test.ts`
 * asserts the round trip is lossless — that test is the guarantee behind "a
 * session can always be resumed", and it is the first thing to fail if a harness
 * upgrade changes the shape.
 *
 * `extra` is what makes that hold across versions: any key this build does not
 * model is kept verbatim and put back on the way out, so an older row still
 * replays exactly instead of losing the part nobody thought to store.
 */

/** Keys this build maps to columns. Anything else on a message goes to `extra`. */
const MAPPED_MESSAGE_KEYS = new Set([
  "role",
  "content",
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "usage",
  "stopReason",
  "errorMessage",
  "timestamp",
  "toolCallId",
  "toolName",
  "isError",
  "details",
])

/** The same, per content block. */
const MAPPED_BLOCK_KEYS = new Set([
  "type",
  "text",
  "textSignature",
  "thinking",
  "thinkingSignature",
  "redacted",
  "id",
  "name",
  "arguments",
  "thoughtSignature",
  "data",
  "mimeType",
])

type MessageRow = typeof chatMessages.$inferSelect
type BlockRow = typeof chatMessageBlocks.$inferSelect
type MessageInsert = typeof chatMessages.$inferInsert
type BlockInsert = typeof chatMessageBlocks.$inferInsert

export interface DrizzleChatSessionStoreOptions {
  /** Recorded on each row, so a failing round trip names the version that wrote it. */
  harnessVersion: string
}

export class DrizzleChatSessionStore implements ChatSessionStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly options: DrizzleChatSessionStoreOptions,
  ) {}

  async list(): Promise<ChatSession[]> {
    const sessions = await this.db.select().from(chatSessions).orderBy(asc(chatSessions.createdAt))
    if (sessions.length === 0) return []
    const counts = await this.db
      .select({
        sessionId: chatMessages.sessionId,
        total: sql<number>`count(*)`,
        queued: sql<number>`sum(case when ${chatMessages.status} = 'QUEUED' then 1 else 0 end)`,
      })
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, sessions.map((session) => session.id)))
      .groupBy(chatMessages.sessionId)
    const bySession = new Map(counts.map((row) => [row.sessionId, row]))

    return sessions.map((session) => {
      const count = bySession.get(session.id)
      return {
        id: session.id,
        title: session.title,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: Number(count?.total ?? 0),
        queued: Number(count?.queued ?? 0),
        // Whether a reply is being generated is a fact about the running process,
        // not about storage; the controller fills it in.
        running: false,
      }
    })
  }

  async get(sessionId: string): Promise<ChatSessionDetail | null> {
    const [session] = await this.db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1)
    if (!session) return null
    const rows = await this.messageRows(sessionId)
    const blocks = await this.blockRows(rows.map((row) => row.id))
    const messages = rows.map((row) => toMessage(row, blocks.get(row.id) ?? []))
    return {
      session: {
        id: session.id,
        title: session.title,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: messages.length,
        queued: messages.filter((message) => message.status === "QUEUED").length,
        running: false,
      },
      messages,
      partial: null,
    }
  }

  /**
   * The harness messages of a session, in order, for replay.
   *
   * Queued messages are left out: a message waiting its turn has not been said
   * yet, so replaying it as history would ask the model to answer it twice.
   */
  async records(sessionId: string): Promise<unknown[]> {
    const rows = (await this.messageRows(sessionId)).filter((row) => row.status !== "QUEUED")
    const blocks = await this.blockRows(rows.map((row) => row.id))
    return rows.map((row) => toRecord(row, blocks.get(row.id) ?? []))
  }

  async create(session: ChatSession): Promise<void> {
    await this.db.insert(chatSessions).values({
      id: session.id,
      title: session.title,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.db.update(chatSessions).set({ title }).where(eq(chatSessions.id, sessionId))
  }

  async delete(sessionId: string): Promise<void> {
    const rows = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
    this.db.transaction((tx) => {
      if (rows.length > 0) {
        tx.delete(chatMessageBlocks).where(inArray(chatMessageBlocks.messageId, rows.map((row) => row.id))).run()
      }
      tx.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId)).run()
      tx.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run()
    })
  }

  /**
   * Writes a message and its blocks together.
   *
   * One transaction, so a half-written turn cannot exist: a row whose blocks did
   * not land would read back as a message the model never said.
   */
  async append(sessionId: string, draft: ChatMessageDraft): Promise<void> {
    const [next] = await this.db
      .select({ seq: max(chatMessages.seq) })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
    const seq = (next?.seq ?? -1) + 1
    const message = toRows(sessionId, seq, draft, this.options.harnessVersion)
    this.db.transaction((tx) => {
      tx.insert(chatMessages).values(message.row).run()
      for (const block of message.blocks) tx.insert(chatMessageBlocks).values(block).run()
      tx.update(chatSessions)
        .set({ updatedAt: draft.message.createdAt })
        .where(eq(chatSessions.id, sessionId))
        .run()
    })
  }

  /** Replaces a message in place, for a reply that grew or finished. */
  async update(messageId: string, draft: ChatMessageDraft): Promise<void> {
    const [existing] = await this.db
      .select({ sessionId: chatMessages.sessionId, seq: chatMessages.seq })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1)
    if (!existing) return
    const message = toRows(existing.sessionId, existing.seq, draft, this.options.harnessVersion)
    this.db.transaction((tx) => {
      tx.delete(chatMessageBlocks).where(eq(chatMessageBlocks.messageId, messageId)).run()
      tx.delete(chatMessages).where(eq(chatMessages.id, messageId)).run()
      tx.insert(chatMessages).values({ ...message.row, id: messageId }).run()
      for (const block of message.blocks) {
        tx.insert(chatMessageBlocks).values({ ...block, messageId }).run()
      }
    })
  }

  async setStatus(messageId: string, status: ChatMessageStatus): Promise<void> {
    await this.db.update(chatMessages).set({ status }).where(eq(chatMessages.id, messageId))
  }

  async markSent(messageId: string): Promise<void> {
    const [existing] = await this.db
      .select({ sessionId: chatMessages.sessionId })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1)
    if (!existing) return
    const [last] = await this.db
      .select({ seq: max(chatMessages.seq) })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, existing.sessionId))
    await this.db
      .update(chatMessages)
      .set({ status: "SENT", seq: (last?.seq ?? -1) + 1 })
      .where(eq(chatMessages.id, messageId))
  }

  async remove(messageId: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(chatMessageBlocks).where(eq(chatMessageBlocks.messageId, messageId)).run()
      tx.delete(chatMessages).where(eq(chatMessages.id, messageId)).run()
    })
  }

  async queuedSessionIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ sessionId: chatMessages.sessionId })
      .from(chatMessages)
      .where(eq(chatMessages.status, "QUEUED"))
    return rows.map((row) => row.sessionId)
  }

  /**
   * A conversation in the order it happened, with what is still waiting after it.
   *
   * Queued messages sort last whatever their `seq`, because they have not been said
   * yet: a question waiting its turn belongs after the answer to the one before it,
   * not between that question and its answer.
   */
  private messageRows(sessionId: string): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(sql`case when ${chatMessages.status} = 'QUEUED' then 1 else 0 end`), asc(chatMessages.seq))
  }

  private async blockRows(messageIds: string[]): Promise<Map<string, BlockRow[]>> {
    if (messageIds.length === 0) return new Map()
    const rows = await this.db
      .select()
      .from(chatMessageBlocks)
      .where(inArray(chatMessageBlocks.messageId, messageIds))
      .orderBy(asc(chatMessageBlocks.idx))
    const byMessage = new Map<string, BlockRow[]>()
    for (const row of rows) {
      const existing = byMessage.get(row.messageId)
      if (existing) existing.push(row)
      else byMessage.set(row.messageId, [row])
    }
    return byMessage
  }
}

interface MessageRows {
  row: MessageInsert
  blocks: BlockInsert[]
}

function toRows(
  sessionId: string,
  seq: number,
  draft: ChatMessageDraft,
  harnessVersion: string,
): MessageRows {
  const { message } = draft
  const record = asObject(draft.record)
  const usage = asObject(record?.usage)
  const cost = asObject(usage?.cost)
  const content = Array.isArray(record?.content) ? record.content : []

  return {
    row: {
      id: message.id,
      sessionId,
      seq,
      role: message.role,
      status: message.status,
      text: message.text,
      api: stringOrNull(record?.api),
      provider: stringOrNull(record?.provider),
      model: stringOrNull(record?.model),
      responseModel: stringOrNull(record?.responseModel),
      responseId: stringOrNull(record?.responseId),
      stopReason: stringOrNull(record?.stopReason),
      errorMessage: stringOrNull(record?.errorMessage) ?? message.errorMessage,
      inputTokens: numberOrNull(usage?.input),
      outputTokens: numberOrNull(usage?.output),
      cacheReadTokens: numberOrNull(usage?.cacheRead),
      cacheWriteTokens: numberOrNull(usage?.cacheWrite),
      totalTokens: numberOrNull(usage?.totalTokens),
      costInput: numberOrNull(cost?.input),
      costOutput: numberOrNull(cost?.output),
      costCacheRead: numberOrNull(cost?.cacheRead),
      costCacheWrite: numberOrNull(cost?.cacheWrite),
      costTotal: numberOrNull(cost?.total),
      toolCallId: stringOrNull(record?.toolCallId) ?? message.toolCallId,
      toolName: stringOrNull(record?.toolName) ?? message.toolName,
      isError: record?.isError === undefined ? null : record.isError === true ? 1 : 0,
      details: record?.details === undefined ? null : JSON.stringify(record.details),
      harnessVersion,
      extra: unmappedJson(record, MAPPED_MESSAGE_KEYS),
      createdAt: message.createdAt,
    },
    blocks: content.map((block, idx) => toBlockRow(message.id, idx, block)),
  }
}

function toBlockRow(messageId: string, idx: number, value: unknown): BlockInsert {
  const block = asObject(value) ?? {}
  const kind = blockKind(stringOrNull(block.type))
  return {
    messageId,
    idx,
    kind,
    text: stringOrNull(kind === "THINKING" ? block.thinking : block.text),
    signature: stringOrNull(block.textSignature ?? block.thinkingSignature ?? block.thoughtSignature),
    redacted: block.redacted === undefined ? null : block.redacted === true ? 1 : 0,
    toolCallId: stringOrNull(block.id),
    toolName: stringOrNull(block.name),
    toolArguments: block.arguments === undefined ? null : JSON.stringify(block.arguments),
    mimeType: stringOrNull(block.mimeType),
    data: stringOrNull(block.data),
    extra: unmappedJson(block, MAPPED_BLOCK_KEYS),
  }
}

/**
 * Rebuilds the harness message a row was written from.
 *
 * Optional fields are only put back when they were stored, so a message that
 * never had a `responseId` does not come back carrying a null one — a round trip
 * has to produce the same object, not an equivalent-looking one.
 */
function toRecord(row: MessageRow, blocks: BlockRow[]): unknown {
  const role = row.role === "USER" ? "user" : row.role === "TOOL_RESULT" ? "toolResult" : "assistant"
  const record: Record<string, unknown> = { role, timestamp: row.createdAt }

  if (role === "user") {
    // A trader's message is text, which the harness accepts as a plain string.
    record.content = row.text
  } else if (role === "toolResult") {
    record.content = blocks.map(toContentBlock)
    record.toolCallId = row.toolCallId
    record.toolName = row.toolName
    record.isError = row.isError === 1
    if (row.details !== null) record.details = parseJson(row.details)
  } else {
    record.content = blocks.map(toContentBlock)
    record.api = row.api
    record.provider = row.provider
    record.model = row.model
    if (row.responseModel !== null) record.responseModel = row.responseModel
    if (row.responseId !== null) record.responseId = row.responseId
    record.usage = {
      input: row.inputTokens ?? 0,
      output: row.outputTokens ?? 0,
      cacheRead: row.cacheReadTokens ?? 0,
      cacheWrite: row.cacheWriteTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
      cost: {
        input: row.costInput ?? 0,
        output: row.costOutput ?? 0,
        cacheRead: row.costCacheRead ?? 0,
        cacheWrite: row.costCacheWrite ?? 0,
        total: row.costTotal ?? 0,
      },
    }
    record.stopReason = row.stopReason
    if (row.errorMessage !== null) record.errorMessage = row.errorMessage
  }

  return { ...record, ...(parseJson(row.extra) as Record<string, unknown> | null) }
}

function toContentBlock(row: BlockRow): unknown {
  const extra = (parseJson(row.extra) as Record<string, unknown> | null) ?? {}
  if (row.kind === "THINKING") {
    return {
      type: "thinking",
      thinking: row.text ?? "",
      ...(row.signature !== null ? { thinkingSignature: row.signature } : {}),
      ...(row.redacted !== null ? { redacted: row.redacted === 1 } : {}),
      ...extra,
    }
  }
  if (row.kind === "TOOL_CALL") {
    return {
      type: "toolCall",
      id: row.toolCallId ?? "",
      name: row.toolName ?? "",
      arguments: parseJson(row.toolArguments) ?? {},
      ...(row.signature !== null ? { thoughtSignature: row.signature } : {}),
      ...extra,
    }
  }
  if (row.kind === "IMAGE") {
    return { type: "image", data: row.data ?? "", mimeType: row.mimeType ?? "", ...extra }
  }
  return {
    type: "text",
    text: row.text ?? "",
    ...(row.signature !== null ? { textSignature: row.signature } : {}),
    ...extra,
  }
}

function toMessage(row: MessageRow, blocks: BlockRow[]): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatRole,
    status: row.status as ChatMessageStatus,
    text: row.text,
    blocks: blocks.map(toChatBlock),
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    isError: row.isError === 1,
    errorMessage: row.errorMessage,
    usage: row.totalTokens === null
      ? null
      : {
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        totalTokens: row.totalTokens,
        costTotal: row.costTotal ?? 0,
      },
    createdAt: row.createdAt,
  }
}

function toChatBlock(row: BlockRow): ChatBlock {
  return {
    kind: row.kind as ChatBlock["kind"],
    text: row.text,
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    toolArguments: parseJson(row.toolArguments),
  }
}

function blockKind(type: string | null): string {
  if (type === "thinking") return "THINKING"
  if (type === "toolCall") return "TOOL_CALL"
  if (type === "image") return "IMAGE"
  return "TEXT"
}

function unmappedJson(value: Record<string, unknown> | null, mapped: Set<string>): string | null {
  if (!value) return null
  const extra: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!mapped.has(key)) extra[key] = entry
  }
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  return JSON.parse(value)
}
