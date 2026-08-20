import { afterEach, expect, test } from "bun:test"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleChatNotificationStore } from "./chat-notification-store.ts"
import { chatSessions } from "./schema.ts"

const NOTICE: ChatNotification = {
  id: "notification-1",
  sessionId: "chat-1",
  title: "Breakout confirmed",
  message: "ASELS held above the watched level.",
  urgency: "IMPORTANT",
  createdAt: 1_786_000_000_000,
}

let connection: DatabaseConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

test("persists pending chat notifications and removes them with their chat", async () => {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "ASELS review",
    model: "test-model",
    createdAt: NOTICE.createdAt,
    updatedAt: NOTICE.createdAt,
  })
  const notifications = new DrizzleChatNotificationStore(connection.db)

  await notifications.put(NOTICE)
  expect(await notifications.list()).toEqual([NOTICE])

  await connection.db.delete(chatSessions)
  expect(await notifications.list()).toEqual([])
})

test("removes a notification after it is acknowledged", async () => {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "ASELS review",
    model: "test-model",
    createdAt: NOTICE.createdAt,
    updatedAt: NOTICE.createdAt,
  })
  const notifications = new DrizzleChatNotificationStore(connection.db)

  await notifications.put(NOTICE)
  await notifications.remove(NOTICE.id)

  expect(await notifications.list()).toEqual([])
})
