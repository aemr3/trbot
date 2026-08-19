import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import { ChatQuestionModal } from "./chat-question-modal.ts"

function key(name: string, sequence?: string): KeyEvent {
  return { name, sequence: sequence ?? name } as KeyEvent
}

function request(questions: ChatQuestionRequest["questions"]): ChatQuestionRequest {
  return { id: "question-1", sessionId: "chat-1", questions }
}

async function modalFor(questions: ChatQuestionRequest["questions"]) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  const answers: ChatQuestionAnswer[][] = []
  let rejected = 0
  const modal = new ChatQuestionModal(harness.renderer, {
    request: request(questions),
    onAnswer: async (value) => { answers.push(value) },
    onReject: async () => { rejected++ },
  })
  harness.renderer.root.add(modal.root)
  return { ...harness, modal, answers, rejected: () => rejected }
}

test("renders choices and submits a single answer", async () => {
  const { modal, answers, renderOnce, captureCharFrame, renderer } = await modalFor([{
    header: "Strategy",
    question: "Which setup should I watch?",
    options: [
      { label: "Breakout", description: "Wait for resistance to break" },
      { label: "Pullback", description: "Wait for a retracement" },
    ],
  }])

  await renderOnce()
  expect(captureCharFrame()).toContain("Which setup should I watch?")
  expect(captureCharFrame()).toContain("Type your own answer")
  modal.handleKey(key("down"))
  modal.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(answers).toEqual([[['Pullback']]])
  modal.destroy()
  renderer.destroy()
})
test("supports multiple choices and a custom answer", async () => {
  const { modal, answers, renderer } = await modalFor([{
    header: "Delivery",
    question: "Where should I notify you?",
    options: [
      { label: "Terminal", description: "Show it in trbot" },
      { label: "Sound", description: "Play an alert sound" },
    ],
    multiple: true,
  }])

  modal.handleKey(key("space", " "))
  modal.handleKey(key("down"))
  modal.handleKey(key("down"))
  modal.handleKey(key("enter"))
  for (const character of "Popup") modal.handleKey(key(character, character))
  modal.handleKey(key("enter"))
  modal.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(answers).toEqual([[['Terminal', 'Popup']]])
  modal.destroy()
  renderer.destroy()
})

test("dismisses the request with Escape", async () => {
  const { modal, rejected, renderer } = await modalFor([{
    header: "Choice",
    question: "Continue?",
    options: [],
  }])

  modal.handleKey(key("escape"))
  await Bun.sleep(0)

  expect(rejected()).toBe(1)
  modal.destroy()
  renderer.destroy()
})
