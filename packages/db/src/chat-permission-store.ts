import { asc, eq } from "drizzle-orm"
import {
  ChatPermissionModeStateSchema,
  ChatPermissionRequestSchema,
  type ChatPermissionMode,
  type ChatPermissionModeState,
  type ChatPermissionRequest,
  type ChatPermissionStore,
} from "@trbot/chat/permission.ts"
import type { AppDatabase } from "./client.ts"
import { chatPermissionRequests, chatSessions } from "./schema.ts"

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

  async getMode(sessionId: string): Promise<ChatPermissionModeState | null> {
    const root = await this.rootSession(sessionId)
    return root && ChatPermissionModeStateSchema.parse({ sessionId: root.id, mode: root.permissionMode })
  }

  async setMode(sessionId: string, mode: ChatPermissionMode): Promise<ChatPermissionModeState | null> {
    const root = await this.rootSession(sessionId)
    if (!root) return null
    await this.db.update(chatSessions).set({ permissionMode: mode }).where(eq(chatSessions.id, root.id))
    return { sessionId: root.id, mode }
  }

  private async rootSession(sessionId: string): Promise<{
    id: string
    parentSessionId: string | null
    permissionMode: ChatPermissionMode
  } | null> {
    const visited = new Set<string>()
    let currentId = sessionId
    while (!visited.has(currentId)) {
      visited.add(currentId)
      const [session] = await this.db
        .select({
          id: chatSessions.id,
          parentSessionId: chatSessions.parentSessionId,
          permissionMode: chatSessions.permissionMode,
        })
        .from(chatSessions)
        .where(eq(chatSessions.id, currentId))
        .limit(1)
      if (!session) return null
      if (!session.parentSessionId) return session
      currentId = session.parentSessionId
    }
    return null
  }
}
