import type { Models } from "@earendil-works/pi-ai"
import { subagentTool } from "./subagent.ts"
import { ChatTools, type ChatToolRegistry } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"

export interface AgentToolsOptions {
  models: Models
  web?: WebToolsOptions
}

/** The complete chat capability set, shared by parents and isolated subagents. */
export function createAgentTools(options: AgentToolsOptions): ChatToolRegistry {
  const tools = new ChatTools(webTools(options.web))
  tools.register(subagentTool(options.models, tools))
  return tools
}
