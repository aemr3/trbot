import type { Models } from "@earendil-works/pi-ai"
import { marketDataTools, type MarketDataToolClients } from "./market-data.ts"
import { priceAlertTools, type PriceAlertToolClients } from "./price-alert.ts"
import { askQuestionTool, type ChatQuestionAsker } from "./question.ts"
import { subagentTool, type SubagentSessionRecorder } from "./subagent.ts"
import { ChatTools, type ChatToolRegistry } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"

export interface AgentToolsOptions {
  models: Models
  web?: WebToolsOptions
  marketData?: MarketDataToolClients
  priceAlerts?: PriceAlertToolClients
  questions?: ChatQuestionAsker
  subagentSessions?: SubagentSessionRecorder
}

/** The complete chat capability set, shared by parents and isolated subagents. */
export function createAgentTools(options: AgentToolsOptions): ChatToolRegistry {
  const tools = new ChatTools(webTools(options.web))
  if (options.marketData) {
    for (const tool of marketDataTools(options.marketData)) tools.register(tool)
  }
  if (options.priceAlerts) {
    for (const tool of priceAlertTools(options.priceAlerts)) tools.register(tool)
  }
  if (options.questions) tools.register(askQuestionTool(options.questions))
  tools.register(subagentTool(options.models, tools, options.subagentSessions))
  return tools
}
