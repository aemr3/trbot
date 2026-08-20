import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import { createTestRenderer } from "@opentui/core/testing"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import { ChatQuestionPanel } from "./chat-question-panel.ts"

function key(name: string, sequence?: string): KeyEvent {
  return keyEvent(name, { sequence: sequence ?? name })
}

function request(questions: ChatQuestionRequest["questions"]): ChatQuestionRequest {
  return { id: "question-1", sessionId: "chat-1", questions }
}

async function panelFor(questions: ChatQuestionRequest["questions"]) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  const answers: ChatQuestionAnswer[][] = []
  let left = 0
  const panel = new ChatQuestionPanel(harness.renderer, {
    request: request(questions),
    onAnswer: async (value) => { answers.push(value) },
    onFocus: () => {},
    onLeave: () => { left++ },
  })
  harness.renderer.root.add(panel.root)
  return { ...harness, panel, answers, left: () => left }
}

test("renders inline choices and submits a single answer", async () => {
  const { panel, answers, renderOnce, captureCharFrame, renderer } = await panelFor([{
    header: "Strategy",
    question: "Which setup should I watch?",
    options: [
      { label: "Breakout", description: "Wait for resistance to break" },
      { label: "Pullback", description: "Wait for a retracement" },
    ],
  }])

  await renderOnce()
  expect(captureCharFrame()).toContain("Agent asks · Strategy")
  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(answers).toEqual([[['Pullback']]])
  panel.destroy()
  renderer.destroy()
})

test("supports multiple choices and a custom answer", async () => {
  const { panel, answers, renderer } = await panelFor([{
    header: "Delivery",
    question: "Where should I notify you?",
    options: [
      { label: "Terminal", description: "Show it in trbot" },
      { label: "Sound", description: "Play an alert sound" },
    ],
    multiple: true,
  }])

  panel.handleKey(key("space", " "))
  panel.handleKey(key("down"))
  panel.handleKey(key("down"))
  panel.handleKey(key("enter"))
  for (const character of "Popup") panel.handleKey(key(character, character))
  panel.handleKey(key("enter"))
  panel.handleKey(key("enter"))
  await Bun.sleep(0)

  expect(answers).toEqual([[['Terminal', 'Popup']]])
  panel.destroy()
  renderer.destroy()
})

test("leaving the inline question keeps it pending", async () => {
  const { panel, answers, left, renderer } = await panelFor([{
    header: "Choice",
    question: "Continue?",
    options: [],
  }])
  panel.handleKey(key("tab"))

  expect(left()).toBe(1)
  expect(answers).toEqual([])
  panel.destroy()
  renderer.destroy()
})
