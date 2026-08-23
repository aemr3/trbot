import { and, eq, or } from "drizzle-orm"
import {
  ChatMobileBindingSchema,
  type ChatMobileBinding,
  type ChatMobileChannel,
  type ChatMobileStore,
} from "@trbot/chat/mobile.ts"
import type { AppDatabase } from "./client.ts"
import { chatMobileConnections } from "./schema.ts"

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

  async removeSession(sessionId: string): Promise<void> {
    await this.db.delete(chatMobileConnections).where(eq(chatMobileConnections.sessionId, sessionId))
  }
}
