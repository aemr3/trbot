import { and, asc, eq, or } from "drizzle-orm"
import {
  ChatMobileBindingSchema,
  ChatMobileTurnMessageSchema,
  ChatMobileTurnSchema,
  type ChatMobileBinding,
  type ChatMobileChannel,
  type ChatMobileStore,
  type ChatMobileTurn,
  type ChatMobileTurnMessage,
} from "@trbot/chat/mobile.ts"
import type { AppDatabase } from "./client.ts"
import { chatMobileConnections, chatMobileTurns } from "./schema.ts"

/** Persists which private mobile account currently receives each chat. */
export class DrizzleChatMobileStore implements ChatMobileStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<ChatMobileBinding[]> {
    const rows = await this.db.select().from(chatMobileConnections)
    return rows.map((row) => ChatMobileBindingSchema.parse(row))
  }

  async findBySession(sessionId: string): Promise<ChatMobileBinding | null> {
    const [row] = await this.db
      .select()
      .from(chatMobileConnections)
      .where(eq(chatMobileConnections.sessionId, sessionId))
      .limit(1)
    return row ? ChatMobileBindingSchema.parse(row) : null
  }

  async findByExternalUser(
    channel: ChatMobileChannel,
    externalUserId: string,
  ): Promise<ChatMobileBinding | null> {
    const [row] = await this.db
      .select()
      .from(chatMobileConnections)
      .where(and(
        eq(chatMobileConnections.channel, channel),
        eq(chatMobileConnections.externalUserId, externalUserId),
      ))
      .limit(1)
    return row ? ChatMobileBindingSchema.parse(row) : null
  }

  async connect(binding: ChatMobileBinding): Promise<void> {
    const parsed = ChatMobileBindingSchema.parse(binding)
    await this.db.delete(chatMobileConnections).where(or(
      eq(chatMobileConnections.sessionId, parsed.sessionId),
      and(
        eq(chatMobileConnections.channel, parsed.channel),
        eq(chatMobileConnections.externalUserId, parsed.externalUserId),
      ),
    ))
    await this.db.insert(chatMobileConnections).values(parsed)
  }

  async setNotificationsMuted(sessionId: string, muted: boolean): Promise<void> {
    await this.db
      .update(chatMobileConnections)
      .set({ notificationsMuted: muted })
      .where(eq(chatMobileConnections.sessionId, sessionId))
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.db.delete(chatMobileConnections).where(eq(chatMobileConnections.sessionId, sessionId))
  }

  async recordTurnMessage(message: ChatMobileTurnMessage): Promise<void> {
    const parsed = ChatMobileTurnMessageSchema.parse(message)
    await this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(chatMobileTurns)
        .where(and(
          eq(chatMobileTurns.promptMessageId, parsed.promptMessageId),
          eq(chatMobileTurns.channel, parsed.channel),
          eq(chatMobileTurns.externalChatId, parsed.externalChatId),
        ))
        .limit(1)
        .get()
      const externalMessageIds = existing
        ? parseTurn(existing).externalMessageIds
        : []
      if (!externalMessageIds.includes(parsed.externalMessageId)) {
        externalMessageIds.push(parsed.externalMessageId)
      }
      tx.insert(chatMobileTurns)
        .values({
          promptMessageId: parsed.promptMessageId,
          sessionId: parsed.sessionId,
          channel: parsed.channel,
          externalChatId: parsed.externalChatId,
          externalMessageIds: JSON.stringify(externalMessageIds),
          createdAt: parsed.createdAt,
        })
        .onConflictDoUpdate({
          target: [chatMobileTurns.promptMessageId, chatMobileTurns.channel, chatMobileTurns.externalChatId],
          set: {
            sessionId: parsed.sessionId,
            channel: parsed.channel,
            externalChatId: parsed.externalChatId,
            externalMessageIds: JSON.stringify(externalMessageIds),
          },
        })
        .run()
    })
  }

  async findTurn(
    promptMessageId: string,
    channel: ChatMobileChannel,
    externalChatId: string,
  ): Promise<ChatMobileTurn | null> {
    const [row] = await this.db
      .select()
      .from(chatMobileTurns)
      .where(and(
        eq(chatMobileTurns.promptMessageId, promptMessageId),
        eq(chatMobileTurns.channel, channel),
        eq(chatMobileTurns.externalChatId, externalChatId),
      ))
      .limit(1)
    return row ? parseTurn(row) : null
  }

  async takeTurns(promptMessageId: string): Promise<ChatMobileTurn[]> {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(chatMobileTurns)
        .where(eq(chatMobileTurns.promptMessageId, promptMessageId))
        .orderBy(asc(chatMobileTurns.externalChatId))
        .all()
      if (rows.length === 0) return []
      tx.delete(chatMobileTurns).where(eq(chatMobileTurns.promptMessageId, promptMessageId)).run()
      return rows.map(parseTurn)
    })
  }
}

function parseTurn(row: typeof chatMobileTurns.$inferSelect): ChatMobileTurn {
  return ChatMobileTurnSchema.parse({
    ...row,
    externalMessageIds: JSON.parse(row.externalMessageIds),
  })
}
