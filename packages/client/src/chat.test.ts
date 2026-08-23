import { expect, test } from "bun:test"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type { ChatPermissionRequest } from "@trbot/chat/permission.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import { HttpChatSessions, ChatClient } from "./chat.ts"
import { HttpClient } from "./http.ts"

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

test("delivers permission request and resolution frames", () => {
  const connection = new FakeChatStream()
  const seen: ChatPermissionRequest[] = []
  const resolved: string[] = []
  new ChatClient(connection, {
    onPermissionRequested: (request) => seen.push(request),
    onPermissionResolved: (_sessionId, requestId) => resolved.push(requestId),
  })
  const request: ChatPermissionRequest = {
    id: "permission-1",
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    reason: null,
    scope: "SESSION",
    createdAt: 1_000,
  }

  connection.emit({ type: "chatPermissionRequested", request })
  connection.emit({ type: "chatPermissionResolved", requestId: request.id, sessionId: request.sessionId })

  expect(seen).toEqual([request])
  expect(resolved).toEqual([request.id])
})

test("requests only the bounded timeline used by the TUI", async () => {
  let requestedUrl = ""
  const http = new HttpClient({
    url: "http://localhost:3000",
    token: "test",
    fetch: async (input) => {
      requestedUrl = String(input)
      return Response.json({
        session: {
          id: "chat-1",
          title: "Test",
          parentSessionId: null,
          agent: null,
          provider: "test",
          model: "test",
          reasoning: null,
          createdAt: 1_000,
          updatedAt: 1_000,
          messageCount: 0,
          queued: 0,
          running: false,
        },
        messages: [],
        partial: null,
      })
    },
  })

  await new HttpChatSessions(http).get("chat-1")

  expect(new URL(requestedUrl).searchParams.get("limit")).toBe("100")
})

test("posts the selected prompt when undoing a chat", async () => {
  let requestedPath = ""
  let requestedBody = ""
  const http = new HttpClient({
    url: "http://localhost:3000",
    token: "test",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requestedPath = new URL(request.url).pathname
      requestedBody = await request.text()
      return Response.json({
        prompt: "second question",
        removedMessageIds: ["message-2", "reply-2"],
        revertedEffects: [],
        preservedEffects: [],
      })
    },
  })

  const result = await new HttpChatSessions(http).undo("chat-1", "message-2")

  expect(requestedPath).toBe("/v1/ai/chat/sessions/chat-1/undo")
  expect(requestedBody).toBe('{"messageId":"message-2","revertEffects":false}')
  expect(result.prompt).toBe("second question")
})

test("previews rewind tool effects without changing the chat", async () => {
  let requestedPath = ""
  let requestedBody = ""
  const http = new HttpClient({
    url: "http://localhost:3000",
    token: "test",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requestedPath = new URL(request.url).pathname
      requestedBody = await request.text()
      return Response.json({
        prompt: "second question",
        effects: [{ description: "Market monitor was created", reversible: true }],
      })
    },
  })

  const result = await new HttpChatSessions(http).previewUndo("chat-1", "message-2")

  expect(requestedPath).toBe("/v1/ai/chat/sessions/chat-1/undo/preview")
  expect(requestedBody).toBe('{"messageId":"message-2"}')
  expect(result.effects).toEqual([{ description: "Market monitor was created", reversible: true }])
})

test("connects, inspects, and disconnects a mobile chat through one route", async () => {
  const requests: Array<{ method: string; path: string }> = []
  const http = new HttpClient({
    url: "http://localhost:3000",
    token: "test",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push({ method: request.method, path: new URL(request.url).pathname })
      if (request.method === "POST") {
        return Response.json({
          channel: "telegram",
          url: "https://t.me/trbot_test_bot?start=pairing-token",
          expiresAt: 10_000,
        })
      }
      if (request.method === "GET") return Response.json({ available: true, connection: null })
      return Response.json({ ok: true })
    },
  })
  const chats = new HttpChatSessions(http)

  expect(await chats.mobile("chat/one")).toEqual({ available: true, connection: null })
  expect((await chats.connectMobile("chat/one")).channel).toBe("telegram")
  await chats.disconnectMobile("chat/one")
  expect(requests).toEqual([
    { method: "GET", path: "/v1/ai/chat/sessions/chat%2Fone/mobile" },
    { method: "POST", path: "/v1/ai/chat/sessions/chat%2Fone/mobile" },
    { method: "DELETE", path: "/v1/ai/chat/sessions/chat%2Fone/mobile" },
  ])
})
