import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import type { AiModelChoice, AiModelSummary } from "@trbot/protocol/ai.ts"
import { AiModelModal } from "./ai-model-modal.ts"

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

function model(overrides: Partial<AiModelSummary> = {}): AiModelSummary {
  return {
    providerId: "groq",
    providerName: "Groq",
    modelId: "llama-4",
    name: "Llama 4",
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 128_000,
    ...overrides,
  }
}

async function mountModal(options: { models: AiModelSummary[]; current?: AiModelChoice | null }) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  const chosen: AiModelChoice[] = []
  let closed = 0
  const modal = new AiModelModal(harness.renderer, {
    load: async () => options.models,
    current: options.current ?? null,
    title: "Model for this chat",
    onChoose: async (choice) => {
      chosen.push(choice)
    },
    onClose: () => {
      closed++
    },
  })
  harness.renderer.root.add(modal.root)
  modal.mount()
  await Bun.sleep(5)
  return { ...harness, modal, chosen, closed: () => closed }
}

test("lists what is usable, named by provider so the same model twice is telling apart", async () => {
  // The same model id is served by more than one provider, and they are not
  // interchangeable — different credentials, different bills.
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    models: [
      model({ providerId: "groq", providerName: "Groq", modelId: "llama-4", name: "Llama 4" }),
      model({ providerId: "openai", providerName: "OpenAI", modelId: "gpt-5.6", name: "GPT-5.6", reasoning: true, thinkingLevels: ["low", "high"] }),
    ],
  })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("Model for this chat")
  expect(frame).toContain("2 available")
  expect(frame).toContain("Groq")
  expect(frame).toContain("Llama 4")
  expect(frame).toContain("OpenAI")
  expect(frame).toContain("GPT-5.6")

  modal.destroy()
  renderer.destroy()
})

test("says so when nothing is connected rather than showing an empty list", async () => {
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({ models: [] })
  await renderOnce()

  expect(captureCharFrame()).toContain("Connect a provider first")

  modal.destroy()
  renderer.destroy()
})

test("a model with one level is chosen outright, with no question to answer", async () => {
  const { modal, chosen, renderer } = await mountModal({ models: [model()] })

  modal.handleKey(key("return"))
  await Bun.sleep(5)

  expect(chosen).toEqual([{ providerId: "groq", modelId: "llama-4", reasoning: "off" }])

  modal.destroy()
  renderer.destroy()
})

test("offers only the levels the chosen model actually supports", async () => {
  // Levels come from the model's own metadata, so a picker cannot offer an effort the
  // provider would refuse — and a model that always thinks has no "off".
  const { modal, chosen, renderOnce, captureCharFrame, renderer } = await mountModal({
    models: [model({ modelId: "claude-fable-5", name: "Fable 5", reasoning: true, thinkingLevels: ["low", "medium", "high", "max"] })],
  })
  await renderOnce()

  modal.handleKey(key("return"))
  await renderOnce()
  const levels = captureCharFrame()
  expect(levels).toContain("Fable 5 — reasoning")
  expect(levels).toContain("low")
  expect(levels).toContain("max")
  expect(levels).not.toContain("off")

  modal.handleKey(key("down"))
  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(chosen).toEqual([{ providerId: "groq", modelId: "claude-fable-5", reasoning: "medium" }])

  modal.destroy()
  renderer.destroy()
})

test("Esc from the level step goes back to the models, not out of the modal", async () => {
  // A wrong model is one keypress to fix, which is the difference between a
  // two-step picker and two modals.
  const { modal, closed, renderOnce, captureCharFrame, renderer } = await mountModal({
    models: [model({ reasoning: true, thinkingLevels: ["low", "high"] })],
  })
  await renderOnce()

  modal.handleKey(key("return"))
  await renderOnce()
  expect(captureCharFrame()).toContain("reasoning")

  modal.handleKey(key("escape"))
  await renderOnce()
  expect(captureCharFrame()).toContain("1 available")
  expect(closed()).toBe(0)

  modal.handleKey(key("escape"))
  expect(closed()).toBe(1)

  modal.destroy()
  renderer.destroy()
})

test("opens on the levels of what is already chosen when only the effort is changing", async () => {
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    models: [model({ reasoning: true, thinkingLevels: ["low", "high"] })],
    current: { providerId: "groq", modelId: "llama-4", reasoning: "low" },
  })
  await renderOnce()

  // The modal was mounted with initial "model", so the model list shows first; the
  // reasoning entry point is exercised through the option below.
  expect(captureCharFrame()).toContain("1 available")

  modal.destroy()
  renderer.destroy()

  const second = await createTestRenderer({ width: 90, height: 26 })
  const chosen: AiModelChoice[] = []
  const reasoningFirst = new AiModelModal(second.renderer, {
    load: async () => [model({ reasoning: true, thinkingLevels: ["low", "high"] })],
    current: { providerId: "groq", modelId: "llama-4", reasoning: "low" },
    title: "Model for this chat",
    initial: "reasoning",
    onChoose: async (choice) => {
      chosen.push(choice)
    },
    onClose: () => {},
  })
  second.renderer.root.add(reasoningFirst.root)
  reasoningFirst.mount()
  await Bun.sleep(5)
  await second.renderOnce()

  expect(second.captureCharFrame()).toContain("reasoning")
  reasoningFirst.handleKey(key("down"))
  reasoningFirst.handleKey(key("return"))
  await Bun.sleep(5)
  expect(chosen).toEqual([{ providerId: "groq", modelId: "llama-4", reasoning: "high" }])

  reasoningFirst.destroy()
  second.renderer.destroy()
})

test("moves through the models even when one is already chosen", async () => {
  // Opening on the current model must not pin the cursor to it: the repaint after each
  // keypress may not drag the highlight back to what is chosen now.
  const { modal, chosen, renderOnce, captureCharFrame, renderer } = await mountModal({
    models: [
      model({ modelId: "llama-4", name: "Llama 4" }),
      model({ modelId: "llama-3", name: "Llama 3" }),
      model({ providerId: "openai", providerName: "OpenAI", modelId: "gpt-5.6", name: "GPT-5.6" }),
    ],
    current: { providerId: "groq", modelId: "llama-4", reasoning: "off" },
  })
  await renderOnce()

  modal.handleKey(key("down"))
  modal.handleKey(key("down"))
  await renderOnce()
  const indicated = captureCharFrame().split("\n").find((line) => line.includes("▶"))
  expect(indicated).toContain("GPT-5.6")

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(chosen).toEqual([{ providerId: "openai", modelId: "gpt-5.6", reasoning: "off" }])

  modal.destroy()
  renderer.destroy()
})
