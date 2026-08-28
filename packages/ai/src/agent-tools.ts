import type { Models } from "@earendil-works/pi-ai"
import { marketDataTools, type MarketDataToolClients } from "./market-data.ts"
import { marketMonitorTools, type MarketMonitorToolClients } from "./market-monitor.ts"
import { notifyUserTool, type ChatNotifier } from "./notification.ts"
import { askQuestionTool, type ChatQuestionAsker } from "./question.ts"
import {
  SubagentConcurrency,
  subagentJobTools,
  subagentTool,
  type SubagentJobsClient,
  type SubagentSessionRecorder,
} from "./subagent.ts"
import { ChatTools, type ChatToolRegistry } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"
import { automationTools, type ChatAutomationToolsClient } from "./automation.ts"
import { tradingTools, type TradingToolClients } from "./trading.ts"
import { stopRuleTools, type StopRuleToolClients } from "./stop-rules.ts"

export interface AgentToolsOptions {
  models: Models
  web?: WebToolsOptions
  marketData?: MarketDataToolClients
  marketMonitors?: MarketMonitorToolClients
  questions?: ChatQuestionAsker
  notifications?: ChatNotifier
  subagentSessions?: SubagentSessionRecorder
  subagentJobs?: SubagentJobsClient
  subagentConcurrency?: SubagentConcurrency
  automations?: ChatAutomationToolsClient
  trading?: TradingToolClients
  stopRules?: StopRuleToolClients
}

/** The complete chat capability set; workers receive a non-delegating view of it. */
export function createAgentTools(options: AgentToolsOptions): ChatToolRegistry {
  const tools = new ChatTools(webTools(options.web))
  if (options.marketData) {
    for (const tool of marketDataTools(options.marketData)) tools.register(tool)
  }
  if (options.marketMonitors) {
    for (const tool of marketMonitorTools(options.marketMonitors)) tools.register(tool)
  }
  if (options.trading) {
    for (const tool of tradingTools(options.trading)) tools.register(tool)
  }
  if (options.stopRules) {
    for (const tool of stopRuleTools(options.stopRules)) tools.register(tool)
  }
  if (options.questions) tools.register(askQuestionTool(options.questions))
  if (options.notifications) tools.register(notifyUserTool(options.notifications))
  if (options.automations) {
    for (const tool of automationTools(options.automations)) tools.register(tool)
  }
  if (options.subagentJobs) {
    for (const tool of subagentJobTools(options.subagentJobs)) tools.register(tool)
  }
  tools.register(subagentTool(
    options.models,
    tools,
    options.subagentSessions,
    options.subagentJobs,
    options.subagentConcurrency,
  ))
  return tools
}
