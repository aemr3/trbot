import type { Models } from "@earendil-works/pi-ai"
import { marketDataTools, type MarketDataToolClients } from "./market-data.ts"
import { marketMonitorTools, type MarketMonitorToolClients } from "./market-monitor.ts"
import { notifyUserTool, type ChatNotifier } from "./notification.ts"
import { askQuestionTool, type ChatQuestionAsker } from "./question.ts"
import { subagentTool, type SubagentSessionRecorder } from "./subagent.ts"
import { ChatTools, type ChatToolRegistry } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"

export interface AgentToolsOptions {
  models: Models
  web?: WebToolsOptions
  marketData?: MarketDataToolClients
  marketMonitors?: MarketMonitorToolClients
  questions?: ChatQuestionAsker
  notifications?: ChatNotifier
  subagentSessions?: SubagentSessionRecorder
}

/** The complete chat capability set, shared by parents and isolated subagents. */
export function createAgentTools(options: AgentToolsOptions): ChatToolRegistry {
  const tools = new ChatTools(webTools(options.web))
  if (options.marketData) {
    for (const tool of marketDataTools(options.marketData)) tools.register(tool)
  }
  if (options.marketMonitors) {
    for (const tool of marketMonitorTools(options.marketMonitors)) tools.register(tool)
  }
  if (options.questions) tools.register(askQuestionTool(options.questions))
  if (options.notifications) tools.register(notifyUserTool(options.notifications))
  tools.register(subagentTool(options.models, tools, options.subagentSessions))
  return tools
}
