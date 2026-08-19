import { expect, test } from "bun:test"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { ChatTitleGenerator, isLowSignalTitleInput, normalizeChatTitle } from "./title.ts"

test("recognizes greetings without mistaking a concrete request for small talk", () => {
  expect(isLowSignalTitleInput("  hello! ")).toBe(true)
  expect(isLowSignalTitleInput("selam")).toBe(true)
  expect(isLowSignalTitleInput("hello, analyze ASELS")).toBe(false)
})

test("normalizes marked titles and removes leaked thinking", () => {
  expect(normalizeChatTitle("<thinking>considering</thinking>\n<title>Analyze ASELS breakout risk</title>"))
    .toBe("Analyze ASELS breakout risk")
  expect(normalizeChatTitle("<title>none</title>")).toBeNull()
})

test("generates a title in an isolated tool-free context", async () => {
  const faux = fauxProvider({ models: [{ id: "title-model", reasoning: true }] })
  faux.setResponses([
    (context) => {
      expect(context.tools).toBeUndefined()
      expect(context.systemPrompt).toContain("3-7 word title")
      expect(context.systemPrompt).not.toContain("trading desk assistant")
      expect(context.messages[0]?.role).toBe("user")
      expect(context.messages[0]?.content).toContain("Where is ASELS heading?")
      return fauxAssistantMessage("<title>Review ASELS price direction</title>")
    },
  ])
  const models = createModels()
  models.setProvider(faux.provider)

  const title = await new ChatTitleGenerator(models).generate({
    model: faux.getModel(),
    message: "Where is ASELS heading?",
  })

  expect(title).toBe("Review ASELS price direction")
})
