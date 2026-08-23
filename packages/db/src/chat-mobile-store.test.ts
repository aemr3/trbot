import { afterEach, expect, test } from "bun:test"
import type { ChatMobileBinding, ChatMobileTurnMessage } from "@trbot/chat/mobile.ts"
import { openDatabase, type DatabaseConnection } from "./client.ts"
import { DrizzleChatMobileStore } from "./chat-mobile-store.ts"
import { chatSessions } from "./schema.ts"

let connection: DatabaseConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

async function setup(): Promise<DrizzleChatMobileStore> {
  connection = await openDatabase(":memory:")
  await connection.db.insert(chatSessions).values([
    { id: "chat-1", title: "First", model: "model", createdAt: 1_000, updatedAt: 1_000 },
    { id: "chat-2", title: "Second", model: "model", createdAt: 2_000, updatedAt: 2_000 },
  ])
  return new DrizzleChatMobileStore(connection.db)
}

function binding(sessionId: string, externalUserId = "user-1"): ChatMobileBinding {
  return {
    sessionId,
    channel: "telegram",
    externalUserId,
    externalChatId: externalUserId,
    displayName: "@trader",
    connectedAt: 3_000,
  }
}

function turnMessage(
  externalMessageId: number,
  externalChatId = "user-1",
): ChatMobileTurnMessage {
  return {
    sessionId: "chat-1",
    promptMessageId: "prompt-1",
    channel: "telegram",
    externalChatId,
    externalMessageId,
    createdAt: 4_000,
  }
}

test("round trips a mobile connection", async () => {
  const store = await setup()
  const connected = binding("chat-1")

  await store.connect(connected)

  expect(await store.findBySession("chat-1")).toEqual(connected)
  expect(await store.findByExternalUser("telegram", "user-1")).toEqual(connected)
  expect(await store.list()).toEqual([connected])
})

test("moves one mobile account to its newly paired chat", async () => {
  const store = await setup()
  await store.connect(binding("chat-1"))
  await store.connect(binding("chat-2"))

  expect(await store.findBySession("chat-1")).toBeNull()
  expect(await store.findBySession("chat-2")).toEqual(binding("chat-2"))
})

test("replaces the account previously attached to a chat", async () => {
  const store = await setup()
  await store.connect(binding("chat-1"))
  await store.connect(binding("chat-1", "user-2"))

  expect(await store.findByExternalUser("telegram", "user-1")).toBeNull()
  expect(await store.findByExternalUser("telegram", "user-2")).toEqual(binding("chat-1", "user-2"))
})

test("deleting a chat cascades its mobile connection", async () => {
  const store = await setup()
  await store.connect(binding("chat-1"))
  await store.recordTurnMessage(turnMessage(10))

  await connection!.db.delete(chatSessions)

  expect(await store.list()).toEqual([])
  expect(await store.findTurn("prompt-1", "telegram", "user-1")).toBeNull()
})

test("records each Telegram message in a durable turn without duplicates", async () => {
  const store = await setup()

  await store.recordTurnMessage(turnMessage(10))
  await store.recordTurnMessage(turnMessage(11))
  await store.recordTurnMessage(turnMessage(11))

  expect(await store.findTurn("prompt-1", "telegram", "user-1")).toEqual({
    sessionId: "chat-1",
    promptMessageId: "prompt-1",
    channel: "telegram",
    externalChatId: "user-1",
    externalMessageIds: [10, 11],
    createdAt: 4_000,
  })
})

test("atomically takes every external copy of an undone turn", async () => {
  const store = await setup()
  await store.recordTurnMessage(turnMessage(10))
  await store.recordTurnMessage(turnMessage(20, "user-2"))

  expect(await store.takeTurns("prompt-1")).toEqual([
    {
      sessionId: "chat-1",
      promptMessageId: "prompt-1",
      channel: "telegram",
      externalChatId: "user-1",
      externalMessageIds: [10],
      createdAt: 4_000,
    },
    {
      sessionId: "chat-1",
      promptMessageId: "prompt-1",
      channel: "telegram",
      externalChatId: "user-2",
      externalMessageIds: [20],
      createdAt: 4_000,
    },
  ])
  expect(await store.takeTurns("prompt-1")).toEqual([])
})
