import { and, asc, eq, inArray, isNull, max, or, sql } from "drizzle-orm"
import {
  ChatBlockKindSchema,
  ChatMessageStatusSchema,
  ChatRoleSchema,
  type ChatBlock,
  type ChatCompaction,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatMessageStatus,
  type ChatModelContext,
  type ChatModelChoice,
  type ChatSession,
  type ChatSessionDetail,
  type ChatSessionStore,
} from "@trbot/chat/session.ts"
import type { AppDatabase } from "./client.ts"
import { chatCompactions, chatMessageBlocks, chatMessages, chatSessions } from "./schema.ts"
import { z } from "zod"

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

/**
 * The same, inside `usage` and its `cost`.
 *
 * These two are the only nested objects taken apart into columns, so they are the
 * only places where a field can hide from the message-level sweep above — the
 * harness reporting reasoning tokens inside `usage` is exactly that case.
 */
const MAPPED_USAGE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"])
const MAPPED_COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "total"])

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
type SessionRow = typeof chatSessions.$inferSelect
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
    const sessions = await this.db
      .select()
      .from(chatSessions)
      .where(isNull(chatSessions.parentSessionId))
      .orderBy(asc(chatSessions.createdAt))
    return this.sessionsWithCounts(sessions)
  }

  async listChildren(parentSessionId: string): Promise<ChatSession[]> {
    const sessions = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.parentSessionId, parentSessionId))
      .orderBy(asc(chatSessions.createdAt))
    return this.sessionsWithCounts(sessions)
  }

  private async sessionsWithCounts(sessions: SessionRow[]): Promise<ChatSession[]> {
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
        parentSessionId: session.parentSessionId,
        agent: session.agent,
        model: session.model,
        provider: session.provider,
        reasoning: session.reasoning,
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
        parentSessionId: session.parentSessionId,
        agent: session.agent,
        model: session.model,
        provider: session.provider,
        reasoning: session.reasoning,
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

  async context(sessionId: string): Promise<ChatModelContext> {
    const [compaction] = await this.db
      .select()
      .from(chatCompactions)
      .where(eq(chatCompactions.sessionId, sessionId))
      .limit(1)
    const rows = (await this.messageRows(sessionId)).filter((row) => {
      if (row.status === "QUEUED") return false
      if (!compaction) return true
      const start = compaction.firstKeptSeq ?? compaction.compactedThroughSeq + 1
      return row.seq >= start
    })
    const blocks = await this.blockRows(rows.map((row) => row.id))
    return {
      compaction: compaction ? {
        sessionId: compaction.sessionId,
        summary: compaction.summary,
        compactedThroughSeq: compaction.compactedThroughSeq,
        firstKeptSeq: compaction.firstKeptSeq,
        tokensBefore: compaction.tokensBefore,
        createdAt: compaction.createdAt,
      } : null,
      records: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        record: toRecord(row, blocks.get(row.id) ?? []),
      })),
    }
  }

  async saveCompaction(compaction: ChatCompaction): Promise<void> {
    await this.db
      .insert(chatCompactions)
      .values(compaction)
      .onConflictDoUpdate({
        target: chatCompactions.sessionId,
        set: {
          summary: compaction.summary,
          compactedThroughSeq: compaction.compactedThroughSeq,
          firstKeptSeq: compaction.firstKeptSeq,
          tokensBefore: compaction.tokensBefore,
          createdAt: compaction.createdAt,
        },
      })
  }

  async inputText(messageId: string): Promise<string | null> {
    const row = this.db
      .select({ text: chatMessages.text, modelContent: chatMessages.modelContent })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1)
      .get()
    return row ? row.modelContent ?? row.text : null
  }

  async create(session: ChatSession): Promise<void> {
    await this.db.insert(chatSessions).values({
      id: session.id,
      title: session.title,
      titleSource: session.parentSessionId ? "user" : null,
      parentSessionId: session.parentSessionId,
      agent: session.agent,
      model: session.model,
      provider: session.provider,
      reasoning: session.reasoning,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.db
      .update(chatSessions)
      .set({ title, titleSource: "user", updatedAt: Date.now() })
      .where(eq(chatSessions.id, sessionId))
  }

  async replaceAutomaticTitle(sessionId: string, expectedTitle: string, title: string): Promise<boolean> {
    const updated = await this.db
      .update(chatSessions)
      .set({ title, titleSource: "auto", updatedAt: Date.now() })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.title, expectedTitle),
          or(isNull(chatSessions.titleSource), eq(chatSessions.titleSource, "auto")),
        ),
      )
      .returning({ id: chatSessions.id })
    return updated.length === 1
  }

  async configure(sessionId: string, choice: ChatModelChoice): Promise<void> {
    await this.db
      .update(chatSessions)
      .set({
        provider: choice.providerId,
        model: choice.modelId,
        reasoning: choice.reasoning,
        updatedAt: Date.now(),
      })
      .where(eq(chatSessions.id, sessionId))
  }

  async delete(sessionId: string): Promise<void> {
    const sessionIds = await this.sessionTreeIds(sessionId)
    const rows = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, sessionIds))
    this.db.transaction((tx) => {
      if (rows.length > 0) {
        tx.delete(chatMessageBlocks).where(inArray(chatMessageBlocks.messageId, rows.map((row) => row.id))).run()
      }
      tx.delete(chatMessages).where(inArray(chatMessages.sessionId, sessionIds)).run()
      tx.delete(chatSessions).where(inArray(chatSessions.id, sessionIds)).run()
    })
  }

  private async sessionTreeIds(sessionId: string): Promise<string[]> {
    const ids = [sessionId]
    let parents = [sessionId]
    while (parents.length > 0) {
      const children = await this.db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(inArray(chatSessions.parentSessionId, parents))
      parents = children.map((row) => row.id).filter((id) => !ids.includes(id))
      ids.push(...parents)
    }
    return ids
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

  async appendEvent(sessionId: string, draft: ChatMessageDraft, eventKey: string): Promise<boolean> {
    return this.db.transaction((tx) => {
      const existing = tx
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.eventKey, eventKey))
        .limit(1)
        .get()
      if (existing) return false

      const next = tx
        .select({ seq: max(chatMessages.seq) })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .get()
      const message = toRows(sessionId, (next?.seq ?? -1) + 1, draft, this.options.harnessVersion)
      tx.insert(chatMessages).values({ ...message.row, eventKey }).run()
      for (const block of message.blocks) tx.insert(chatMessageBlocks).values(block).run()
      tx.update(chatSessions)
        .set({ updatedAt: draft.message.createdAt })
        .where(eq(chatSessions.id, sessionId))
        .run()
      return true
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
  const parsedRecord = JsonObjectSchema.safeParse(draft.record)
  const record = parsedRecord.success ? parsedRecord.data : null
  const usage = asObject(record?.usage)
  const cost = asObject(usage?.cost)
  const content = Array.isArray(record?.content) ? record.content : []
  const appEventContent = z.string().safeParse(record?.content)

  return {
    row: {
      id: message.id,
      sessionId,
      seq,
      role: message.role,
      status: message.status,
      text: message.text,
      modelContent: message.role === "APP_EVENT" && appEventContent.success
        ? appEventContent.data
        : null,
      api: stringOrNull(record?.api),
      provider: stringOrNull(record?.provider),
      model: stringOrNull(record?.model),
      responseModel: stringOrNull(record?.responseModel),
      reasoning: message.reasoning,
      elapsedMs: message.elapsedMs,
      thinkingMs: message.thinkingMs,
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
      extra: messageExtraJson(record, usage, cost),
      createdAt: message.createdAt,
    },
    blocks: content.map((block, idx) => toBlockRow(message.id, idx, block)),
  }
}

function toBlockRow(messageId: string, idx: number, value: JsonEntry): BlockInsert {
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
function toRecord(row: MessageRow, blocks: BlockRow[]): JsonObject {
  const role = row.role === "USER" || row.role === "APP_EVENT"
    ? "user"
    : row.role === "TOOL_RESULT"
      ? "toolResult"
      : "assistant"
  const record: JsonObject = { role, timestamp: row.createdAt }

  if (role === "user") {
    // A trader's message is text, which the harness accepts as a plain string.
    record.content = row.modelContent ?? row.text
  } else if (role === "toolResult") {
    record.content = blocks.map(toContentBlock)
    record.toolCallId = row.toolCallId
    record.toolName = row.toolName
    record.isError = row.isError === 1
    if (row.details !== null) record.details = parseJson(row.details)
    // A tool result may carry usage of its own. Unlike a reply's, it is optional,
    // so it comes back only when something was actually stored.
    if (row.totalTokens !== null || row.inputTokens !== null || row.outputTokens !== null) {
      record.usage = usageOf(row)
    }
  } else {
    record.content = blocks.map(toContentBlock)
    record.api = row.api
    record.provider = row.provider
    record.model = row.model
    if (row.responseModel !== null) record.responseModel = row.responseModel
    if (row.responseId !== null) record.responseId = row.responseId
    record.usage = usageOf(row)
    record.stopReason = row.stopReason
    if (row.errorMessage !== null) record.errorMessage = row.errorMessage
  }

  return withExtra(record, row.extra)
}

function usageOf(row: MessageRow): JsonObject {
  return {
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
}

function toContentBlock(row: BlockRow): JsonObject {
  const extra = parseObjectJson(row.extra) ?? {}
  if (row.kind === "THINKING") {
    const block: JsonObject = {
      type: "thinking",
      thinking: row.text ?? "",
      ...extra,
    }
    if (row.signature !== null) block.thinkingSignature = row.signature
    if (row.redacted !== null) block.redacted = row.redacted === 1
    return block
  }
  if (row.kind === "TOOL_CALL") {
    const block: JsonObject = {
      type: "toolCall",
      id: row.toolCallId ?? "",
      name: row.toolName ?? "",
      arguments: parseJson(row.toolArguments) ?? {},
      ...extra,
    }
    if (row.signature !== null) block.thoughtSignature = row.signature
    return block
  }
  if (row.kind === "IMAGE") {
    return { type: "image", data: row.data ?? "", mimeType: row.mimeType ?? "", ...extra }
  }
  const block: JsonObject = {
    type: "text",
    text: row.text ?? "",
    ...extra,
  }
  if (row.signature !== null) block.textSignature = row.signature
  return block
}

function toMessage(row: MessageRow, blocks: BlockRow[]): ChatMessage {
  return {
    id: row.id,
    role: ChatRoleSchema.parse(row.role),
    status: ChatMessageStatusSchema.parse(row.status),
    text: row.text,
    blocks: blocks.map(toChatBlock),
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    isError: row.isError === 1,
    errorMessage: row.errorMessage,
    model: row.responseModel ?? row.model,
    reasoning: row.reasoning,
    elapsedMs: row.elapsedMs,
    thinkingMs: row.thinkingMs,
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
    kind: ChatBlockKindSchema.parse(row.kind),
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

function unmappedJson(value: JsonObject | null, mapped: Set<string>): string | null {
  const extra = unmappedEntries(value, mapped)
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
}

function unmappedEntries(
  value: JsonObject | null,
  mapped: Set<string>,
): JsonObject {
  const extra: JsonObject = {}
  if (!value) return extra
  for (const [key, entry] of Object.entries(value)) {
    if (!mapped.has(key)) extra[key] = entry
  }
  return extra
}

/**
 * What a message carries that no column holds, `usage` included.
 *
 * Nested unmapped fields are kept under `usage` and `usage.cost` so they can be
 * merged back onto the rebuilt objects rather than replacing them; see
 * `withExtra`.
 */
function messageExtraJson(
  record: JsonObject | null,
  usage: JsonObject | null,
  cost: JsonObject | null,
): string | null {
  const extra = unmappedEntries(record, MAPPED_MESSAGE_KEYS)
  const usageExtra = unmappedEntries(usage, MAPPED_USAGE_KEYS)
  const costExtra = unmappedEntries(cost, MAPPED_COST_KEYS)
  if (Object.keys(costExtra).length > 0) usageExtra.cost = costExtra
  if (Object.keys(usageExtra).length > 0) extra.usage = usageExtra
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
}

/**
 * Puts the unmapped fields back on a rebuilt message.
 *
 * A plain spread is right for everything except `usage`: that one was rebuilt from
 * columns, so its stored remainder has to merge into it. Overwriting it with the
 * remainder would trade one lost field for five.
 */
function withExtra(record: JsonObject, stored: string | null): JsonObject {
  const extra = parseObjectJson(stored)
  if (!extra) return record

  const merged = { ...record, ...extra }
  const usageExtra = asObject(extra.usage)
  const usage = asObject(record.usage)
  if (!usageExtra || !usage) return merged

  const costExtra = asObject(usageExtra.cost)
  const cost = asObject(usage.cost)
  const mergedCost: JsonObject = {}
  if (costExtra && cost) mergedCost.cost = { ...cost, ...costExtra }
  merged.usage = {
    ...usage,
    ...usageExtra,
    ...mergedCost,
  }
  return merged
}

const JsonEntrySchema = z.json()
type JsonEntry = z.output<typeof JsonEntrySchema>
const JsonObjectSchema = z.record(z.string(), JsonEntrySchema)
type JsonObject = z.output<typeof JsonObjectSchema>

function asObject(value: JsonEntry | undefined): JsonObject | null {
  const parsed = JsonObjectSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function stringOrNull(value: JsonEntry | undefined): string | null {
  const parsed = z.string().safeParse(value)
  return parsed.success ? parsed.data : null
}

function numberOrNull(value: JsonEntry | undefined): number | null {
  const parsed = z.number().safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseJson(value: string | null): JsonEntry | null {
  if (value === null) return null
  try {
    const parsed = JsonEntrySchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parseObjectJson(value: string | null): JsonObject | null {
  return asObject(parseJson(value))
}
