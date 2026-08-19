import { expect, test } from "bun:test"
import { createModels, fauxProvider } from "@earendil-works/pi-ai"
import { createAgentTools } from "./agent-tools.ts"

test("gives parents and subagents the complete chat toolset", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({ models })

  expect(tools.list().map((tool) => tool.name)).toEqual(["web_search", "fetch_content", "subagent"])
})
