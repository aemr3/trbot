import { expect, test } from "bun:test"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import { ChatQuestionController } from "./chat-question.ts"

const prompts = [{
  header: "Setup",
  question: "Which setup?",
  options: [{ label: "Breakout", description: "Trade a breakout" }],
}]

test("broadcasts a pending question and resumes it with the user's answer", async () => {
  const frames: ChatFrame[] = []
  const questions = new ChatQuestionController({ broadcast: (frame) => frames.push(frame) })

  const waiting = questions.ask({ sessionId: "chat-1", questions: prompts })
  const [request] = questions.list()
  expect(request).toMatchObject({ sessionId: "chat-1", questions: prompts })
  expect(frames).toEqual([{ type: "chatQuestionAsked", request }])

  questions.reply(request!.id, [["Breakout"]])

  expect(await waiting).toEqual([["Breakout"]])
  expect(questions.list()).toEqual([])
  expect(frames.at(-1)).toEqual({
    type: "chatQuestionResolved",
    requestId: request!.id,
    sessionId: "chat-1",
  })
})

test("dismisses and aborts pending questions without leaving stale requests", async () => {
  const questions = new ChatQuestionController({ broadcast: () => {} })
  const dismissed = questions.ask({ sessionId: "chat-1", questions: prompts })
  questions.reject(questions.list()[0]!.id)
  expect(dismissed).rejects.toThrow("dismissed")

  const controller = new AbortController()
  const aborted = questions.ask({ sessionId: "chat-2", questions: prompts, signal: controller.signal })
  controller.abort()
  expect(aborted).rejects.toMatchObject({ name: "AbortError" })
  expect(questions.list()).toEqual([])
})

test("validates answers before resolving the pending tool", async () => {
  const questions = new ChatQuestionController({ broadcast: () => {} })
  const waiting = questions.ask({ sessionId: "chat-1", questions: prompts })
  const request = questions.list()[0]!

  expect(() => questions.reply(request.id, [["First", "Second"]])).toThrow("only one answer")
  expect(questions.list()).toHaveLength(1)

  questions.reply(request.id, [["Custom answer"]])
  expect(await waiting).toEqual([["Custom answer"]])
})
