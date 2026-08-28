import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai"
import { z } from "zod"

export interface TestChatHarness {
  models: MutableModels
  model: Model<Api>
}

/** A complete harness model for server tests that do not call the model itself. */
export function testModel(id: string): Model<Api> {
  return fauxProvider({ models: [{ id, reasoning: true }] }).getModel()
}

/** A credential-free model harness for server tests that exercise a complete chat run. */
export function testChatHarness(
  id: string,
  responses: Array<(prompt: string) => string | Promise<string>>,
): TestChatHarness {
  const provider = fauxProvider({ models: [{ id, reasoning: true }] })
  const models = createModels()
  models.setProvider(provider.provider)
  provider.setResponses(responses.map((response) => (
    async (context) => {
      const prompt = context.messages.at(-1)?.role === "user"
        ? context.messages.at(-1)?.content
        : ""
      return fauxAssistantMessage(await response(z.string().safeParse(prompt).data ?? ""))
    }
  )))
  return { models, model: provider.getModel() }
}
