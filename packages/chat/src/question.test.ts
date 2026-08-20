import { expect, test } from "bun:test"
import {
  ChatQuestionAnswersSchema,
  ChatQuestionRequestSchema,
} from "./question.ts"

test("validates a complete interactive question request", () => {
  const request = {
    id: "question-1",
    sessionId: "chat-1",
    questions: [{
      header: "Strategy",
      question: "Which setup should I watch?",
      options: [{ label: "Breakout", description: "Wait for resistance to break" }],
      multiple: false,
    }],
  }

  expect(ChatQuestionRequestSchema.safeParse(request).success).toBe(true)
})

test("rejects malformed nested prompts at the shared boundary", () => {
  expect(ChatQuestionRequestSchema.safeParse({
    id: "question-1",
    sessionId: "chat-1",
    questions: [{ header: "Strategy", question: "Which setup?", options: [{}] }],
  }).success).toBe(false)
  expect(ChatQuestionRequestSchema.safeParse({
    id: "question-1",
    sessionId: "chat-1",
    questions: [],
  }).success).toBe(false)
})

test("validates ordered answer groups", () => {
  expect(ChatQuestionAnswersSchema.safeParse([["Breakout"], ["Terminal", "Sound"]]).success).toBe(true)
  expect(ChatQuestionAnswersSchema.safeParse(["Breakout"]).success).toBe(false)
  expect(ChatQuestionAnswersSchema.safeParse([[""]]).success).toBe(false)
})
