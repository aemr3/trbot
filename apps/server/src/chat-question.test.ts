import { expect, test } from "bun:test"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import type { ChatQuestionRequest, ChatQuestionStore } from "@trbot/chat/question.ts"
import { ChatQuestionController } from "./chat-question.ts"

const prompts = [{
  header: "Setup",
  question: "Which setup?",
  options: [{ label: "Breakout", description: "Trade a breakout" }],
}]

function store(initial: ChatQuestionRequest[] = []): ChatQuestionStore {
  const requests = [...initial]
  return {
    list: async () => [...requests],
    put: async (request) => { requests.push(request) },
    remove: async (id) => {
      const index = requests.findIndex((request) => request.id === id)
      if (index >= 0) requests.splice(index, 1)
    },
  }
}

test("broadcasts a pending question and resumes it with the user's answer", async () => {
  const frames: ChatFrame[] = []
  const questions = new ChatQuestionController({ store: store(), broadcast: (frame) => frames.push(frame) })

  const waiting = questions.ask({ sessionId: "chat-1", questions: prompts })
  await Bun.sleep(0)
  const [request] = questions.list()
  expect(request).toMatchObject({ sessionId: "chat-1", questions: prompts })
  expect(frames).toEqual([{ type: "chatQuestionAsked", request }])

  await questions.reply(request!.id, [["Breakout"]])

  expect(await waiting).toEqual([["Breakout"]])
  expect(questions.list()).toEqual([])
  expect(frames.at(-1)).toEqual({
    type: "chatQuestionResolved",
    requestId: request!.id,
    sessionId: "chat-1",
  })
})

test("dismisses and aborts pending questions without leaving stale requests", async () => {
  const questions = new ChatQuestionController({ store: store(), broadcast: () => {} })
  const dismissed = questions.ask({ sessionId: "chat-1", questions: prompts })
  await Bun.sleep(0)
  await questions.reject(questions.list()[0]!.id)
  expect(dismissed).rejects.toThrow("dismissed")

  const controller = new AbortController()
  const aborted = questions.ask({ sessionId: "chat-2", questions: prompts, signal: controller.signal })
  await Bun.sleep(0)
  controller.abort()
  expect(aborted).rejects.toMatchObject({ name: "AbortError" })
  expect(questions.list()).toEqual([])
})

test("validates answers before resolving the pending tool", async () => {
  const questions = new ChatQuestionController({ store: store(), broadcast: () => {} })
  const waiting = questions.ask({ sessionId: "chat-1", questions: prompts })
  await Bun.sleep(0)
  const request = questions.list()[0]!

  await expect(questions.reply(request.id, [["First", "Second"]])).rejects.toThrow("only one answer")
  expect(questions.list()).toHaveLength(1)

  await questions.reply(request.id, [["Custom answer"]])
  expect(await waiting).toEqual([["Custom answer"]])
})

test("loads a durable question and resumes its chat with the answer", async () => {
  const request: ChatQuestionRequest = {
    id: "question-1",
    sessionId: "chat-1",
    questions: prompts,
  }
  const persistence = store([request])
  const resumed: string[] = []
  const questions = new ChatQuestionController({
    store: persistence,
    broadcast: () => {},
    onDetachedAnswer: async (pending, answers) => {
      resumed.push(`${pending.id}:${answers[0]?.join(",")}`)
    },
  })
  await questions.load()

  await questions.reply(request.id, [["Breakout"]])

  expect(resumed).toEqual(["question-1:Breakout"])
  expect(await persistence.list()).toEqual([])
})

test("keeps a pending question durable while the server shuts down", async () => {
  const persistence = store()
  const questions = new ChatQuestionController({ store: persistence, broadcast: () => {} })
  const waiting = questions.ask({ sessionId: "chat-1", questions: prompts })
  await Bun.sleep(0)

  questions.destroy()

  await expect(waiting).rejects.toThrow("shutting down")
  expect(await persistence.list()).toHaveLength(1)
})
