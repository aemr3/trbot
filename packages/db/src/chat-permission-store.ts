import { asc, eq } from "drizzle-orm"
import {
  ChatPermissionRequestSchema,
  type ChatPermissionRequest,
  type ChatPermissionStore,
} from "@trbot/chat/permission.ts"
import type { AppDatabase } from "./client.ts"
import { chatPermissionRequests } from "./schema.ts"

/** Persists pending approvals so they survive a disconnected terminal. */
export class DrizzleChatPermissionStore implements ChatPermissionStore {
  constructor(private readonly db: AppDatabase) {}

  async listRequests(): Promise<ChatPermissionRequest[]> {
    const rows = await this.db
      .select()
      .from(chatPermissionRequests)
      .orderBy(asc(chatPermissionRequests.createdAt))
    return rows.map((row) => ChatPermissionRequestSchema.parse(row))
  }

  async putRequest(request: ChatPermissionRequest): Promise<void> {
    await this.db.insert(chatPermissionRequests).values(request)
  }

  async removeRequest(id: string): Promise<void> {
    await this.db.delete(chatPermissionRequests).where(eq(chatPermissionRequests.id, id))
  }
}
