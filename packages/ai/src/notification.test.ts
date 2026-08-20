import { expect, test } from "bun:test"
import { notifyUserTool } from "./notification.ts"
import { ChatTools } from "./tool.ts"

test("sends a non-blocking notification owned by the current chat", async () => {
  const sent: unknown[] = []
  const tools = new ChatTools([notifyUserTool({
    notify: async (input) => {
      sent.push(input)
      return { id: "notice-1", ...input, createdAt: 1_000 }
    },
  })])

  const outcome = await tools.call({
    type: "toolCall",
    id: "notify-1",
    name: "notify_user",
    arguments: { title: "Level reached", message: "ASELS crossed 120.", urgency: "IMPORTANT" },
  }, { chatSessionId: "chat-1" })

  expect(outcome.isError).toBe(false)
  expect(sent).toEqual([{
    sessionId: "chat-1",
    title: "Level reached",
    message: "ASELS crossed 120.",
    urgency: "IMPORTANT",
  }])
})

test("shares a three-notification limit across one agent turn", async () => {
  let sent = 0
  const tools = new ChatTools([notifyUserTool({
    notify: async (input) => ({ id: `notice-${++sent}`, ...input, createdAt: sent }),
  })])
  const notificationBudget = { sent: 0 }

  for (let index = 0; index < 3; index++) {
    const outcome = await tools.call({
      type: "toolCall",
      id: `notify-${index}`,
      name: "notify_user",
      arguments: { title: `Notice ${index}`, message: "Important update" },
    }, { chatSessionId: "chat-1", notificationBudget })
    expect(outcome.isError).toBe(false)
  }
  const refused = await tools.call({
    type: "toolCall",
    id: "notify-4",
    name: "notify_user",
    arguments: { title: "One too many", message: "Should not be sent" },
  }, { chatSessionId: "chat-1", notificationBudget })

  expect(refused.isError).toBe(true)
  expect(refused.blocks[0]?.text).toContain("Notification limit reached")
  expect(sent).toBe(3)
})
