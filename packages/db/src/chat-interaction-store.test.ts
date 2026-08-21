import { afterEach, expect, test } from "bun:test"
import type { ChatPermissionRequest } from "@trbot/chat/permission.ts"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleChatPermissionStore } from "./chat-permission-store.ts"
import { DrizzleChatQuestionStore } from "./chat-question-store.ts"
import { chatSessions } from "./schema.ts"

let connection: DatabaseConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

async function stores() {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values({
    id: "chat-1",
    title: "Permission test",
    model: "test-model",
    createdAt: 1_000,
    updatedAt: 1_000,
  })
  return {
    questions: new DrizzleChatQuestionStore(connection.db),
    permissions: new DrizzleChatPermissionStore(connection.db),
  }
}

test("persists pending questions and removes them with their chat", async () => {
  const { questions } = await stores()
  const request: ChatQuestionRequest = {
    id: "question-1",
    sessionId: "chat-1",
    questions: [{ header: "Setup", question: "Continue?", options: [] }],
  }

  await questions.put(request, 1_000)
  expect(await questions.list()).toEqual([request])

  await connection!.db.delete(chatSessions)
  expect(await questions.list()).toEqual([])
})

test("persists pending permissions and removes them with their chat", async () => {
  const { permissions } = await stores()
  const request: ChatPermissionRequest = {
    id: "permission-1",
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    reason: "Open the planned position",
    scope: "SESSION",
    createdAt: 1_000,
  }

  await permissions.putRequest(request)
  expect(await permissions.listRequests()).toEqual([request])

  await permissions.removeRequest(request.id)
  expect(await permissions.listRequests()).toEqual([])

  await permissions.putRequest(request)
  await connection!.db.delete(chatSessions)
  expect(await permissions.listRequests()).toEqual([])
})
