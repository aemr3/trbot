import { expect, test } from "bun:test"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import { ChatClient } from "./chat.ts"
import type { StreamConnection } from "./stream.ts"

test("delivers notification creation and dismissal frames", () => {
  let receive: ((frame: ServerFrame) => void) | null = null
  const connection = {
    on(listener: (frame: ServerFrame) => void) {
      receive = listener
      return () => {}
    },
  } as StreamConnection
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

  const dispatch = receive as ((frame: ServerFrame) => void) | null
  dispatch?.({ type: "chatNotification", notification })
  dispatch?.({ type: "chatNotificationDismissed", notificationId: notification.id })

  expect(seen).toEqual([notification])
  expect(dismissed).toEqual([notification.id])
})
