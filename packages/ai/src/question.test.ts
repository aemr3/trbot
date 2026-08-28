import { expect, test } from "bun:test"
import type { ChatQuestionAnswer } from "@trbot/chat/question.ts"
import { askQuestionTool, type ChatQuestionAsker } from "./question.ts"
import { ChatTools } from "./tool.ts"

test("asks within the originating chat and returns the answers to the model", async () => {
  const calls: Parameters<ChatQuestionAsker["ask"]>[0][] = []
  const answers: ChatQuestionAnswer[] = [["Breakout"], ["Email", "Terminal"]]
  const questions: ChatQuestionAsker = {
    ask: async (input) => {
      calls.push(input)
      return answers
    },
  }
  const tools = new ChatTools([askQuestionTool(questions)])

  const outcome = await tools.call({
    type: "toolCall",
    id: "question-1",
    name: "ask_question",
    arguments: {
      questions: [
        {
          header: "Strategy",
          question: "Which setup should I watch?",
          options: [{ label: "Breakout", description: "Wait for resistance to break" }],
        },
        {
          header: "Delivery",
          question: "Where should I notify you?",
          options: [
            { label: "Email", description: "Send an email" },
            { label: "Terminal", description: "Show it in trbot" },
          ],
          multiple: true,
        },
      ],
    },
  }, { chatSessionId: "chat-1" })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.sessionId).toBe("chat-1")
  expect(outcome.blocks[0]?.text).toContain('"Which setup should I watch?"="Breakout"')
  expect(outcome.modelBlocks?.[0]?.text).toContain('"Which setup should I watch?"="Breakout"')
  expect(outcome.isError).toBe(false)
})

test("refuses to ask outside a chat session", async () => {
  const tools = new ChatTools([askQuestionTool({ ask: async () => [] })])

  const outcome = await tools.call({
    type: "toolCall",
    id: "question-1",
    name: "ask_question",
    arguments: {
      questions: [{ header: "Choice", question: "Choose one", options: [] }],
    },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toBe("Questions must belong to a chat session")
})
