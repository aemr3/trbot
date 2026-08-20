import { expect, test } from "bun:test"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import { ChatClient } from "./chat.ts"

class FakeChatStream {
  private listener: ((frame: ServerFrame) => void) | null = null

  on(listener: (frame: ServerFrame) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  emit(frame: ServerFrame): void {
    this.listener?.(frame)
  }
}

test("delivers notification creation and dismissal frames", () => {
  const connection = new FakeChatStream()
  const seen: ChatNotification[] = []
  const dismissed: string[] = []
  new ChatClient(connection, {
    onNotification: (notification) => seen.push(notification),
    onNotificationDismissed: (notificationId) => dismissed.push(notificationId),
  })
  const notification: ChatNotification = {
    id: "notice-1",
    sessionId: "chat-1",
    title: "Review complete",
    message: "The setup remains valid.",
    urgency: "INFO",
    createdAt: 1_000,
  }

  connection.emit({ type: "chatNotification", notification })
  connection.emit({ type: "chatNotificationDismissed", notificationId: notification.id })

  expect(seen).toEqual([notification])
  expect(dismissed).toEqual([notification.id])
})
