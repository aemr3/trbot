import { asc, eq } from "drizzle-orm"
import { ChatNotificationSchema, type ChatNotification, type ChatNotificationStore } from "@trbot/chat/notification.ts"
import type { AppDatabase } from "./client.ts"
import { chatNotifications } from "./schema.ts"

/** Keeps pending agent notices until a client acknowledges them. */
export class DrizzleChatNotificationStore implements ChatNotificationStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<ChatNotification[]> {
    const rows = await this.db.select().from(chatNotifications).orderBy(asc(chatNotifications.createdAt))
    return rows.flatMap((row) => {
      const parsed = ChatNotificationSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  }

  async put(notification: ChatNotification): Promise<void> {
    await this.db.insert(chatNotifications).values(notification)
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(chatNotifications).where(eq(chatNotifications.id, id))
  }
}
