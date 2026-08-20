import { expect, test } from "bun:test"
import type { ChatNotification, ChatNotificationStore } from "@trbot/chat/notification.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import { ChatNotificationController } from "./chat-notification.ts"

function store(initial: ChatNotification[] = []): ChatNotificationStore & { rows: ChatNotification[] } {
  const rows = [...initial]
  return {
    rows,
    list: async () => [...rows],
    put: async (notification) => { rows.push(notification) },
    remove: async (id) => {
      const index = rows.findIndex((notification) => notification.id === id)
      if (index >= 0) rows.splice(index, 1)
    },
  }
}

test("persists, broadcasts, and dismisses an agent notification", async () => {
  const persistence = store()
  const frames: ChatFrame[] = []
  const notifications = new ChatNotificationController({
    store: persistence,
    broadcast: (frame) => frames.push(frame),
    now: () => 1_000,
  })

  const notification = await notifications.notify({
    sessionId: "chat-1",
    title: "Level reached",
    message: "ASELS crossed 120.",
    urgency: "IMPORTANT",
  })

  expect(persistence.rows).toEqual([notification])
  expect(frames).toEqual([{ type: "chatNotification", notification }])
  expect(notifications.backlog()).toEqual([{ type: "chatNotification", notification }])

  await notifications.dismiss(notification.id)
  expect(persistence.rows).toEqual([])
  expect(frames.at(-1)).toEqual({ type: "chatNotificationDismissed", notificationId: notification.id })
})

test("loads notifications created while the server was offline", async () => {
  const notification: ChatNotification = {
    id: "notice-1",
    sessionId: "chat-1",
    title: "Review complete",
    message: "The setup is still valid.",
    urgency: "INFO",
    createdAt: 1_000,
  }
  const notifications = new ChatNotificationController({ store: store([notification]), broadcast: () => {} })

  await notifications.load()

  expect(notifications.list()).toEqual([notification])
})

test("announces notifications removed by a chat deletion cascade", async () => {
  const notification: ChatNotification = {
    id: "notice-1",
    sessionId: "chat-1",
    title: "Review complete",
    message: "The setup is still valid.",
    urgency: "INFO",
    createdAt: 1_000,
  }
  const persistence = store([notification])
  const frames: ChatFrame[] = []
  const notifications = new ChatNotificationController({
    store: persistence,
    broadcast: (frame) => frames.push(frame),
  })
  await notifications.load()
  persistence.rows.splice(0)

  await notifications.sync()

  expect(notifications.list()).toEqual([])
  expect(frames).toEqual([{ type: "chatNotificationDismissed", notificationId: notification.id }])
})
