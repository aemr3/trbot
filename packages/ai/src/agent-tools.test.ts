import { expect, test } from "bun:test"
import { createModels, fauxProvider } from "@earendil-works/pi-ai"
import { createAgentTools } from "./agent-tools.ts"
import type { ChatAutomationToolsClient } from "./automation.ts"

const unavailableAutomation = async (): Promise<never> => {
  throw new Error("Automation execution is not part of this registry test")
}

const automations: ChatAutomationToolsClient = {
  state: unavailableAutomation,
  createGoal: unavailableAutomation,
  finishGoal: unavailableAutomation,
  createLoop: unavailableAutomation,
  rescheduleLoop: unavailableAutomation,
  cancelLoop: unavailableAutomation,
}

test("builds the complete root chat toolset", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({ models })

  expect(tools.list().map((tool) => tool.name)).toEqual(["web_search", "fetch_content", "subagent"])
})

test("adds the durable market-monitor tools when the server provides them", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    marketMonitors: {
      instruments: { listInstruments: async () => [] },
      candles: { loadCandles: async () => { throw new Error("not called") } },
      monitors: {
        list: async () => [],
        save: async () => { throw new Error("not called") },
        setStatus: async () => {},
        remove: async () => {},
      },
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "create_market_monitor",
    "list_market_monitors",
    "update_market_monitor",
    "set_market_monitor_status",
    "cancel_market_monitor",
    "subagent",
  ])
})

test("adds interactive questions to the root toolset", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    questions: { ask: async () => [] },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "ask_question",
    "subagent",
  ])
})

test("adds non-blocking user notifications to the root toolset", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    notifications: {
      notify: async (input) => ({ id: "notice-1", ...input, createdAt: 1_000 }),
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "notify_user",
    "subagent",
  ])
})

test("adds persistent goal and loop tools to the shared registry", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({ models, automations })

  const definitions = tools.list()
  expect(definitions.map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "get_goal",
    "create_goal",
    "update_goal",
    "create_loop",
    "list_loops",
    "cancel_loop",
    "reschedule_loop",
    "subagent",
  ])
  expect(definitions.find((tool) => tool.name === "create_goal")?.description).toContain(
    "Never use a goal for waiting, recurring monitoring",
  )
  expect(definitions.find((tool) => tool.name === "create_loop")?.description).toContain(
    "Never use a loop to pace an active goal",
  )
})

test("adds every read-only market tool when the server provides its clients", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    marketData: {
      sources: () => { throw new Error("not called") },
      candleData: {
        instruments: {
          resolveCandleInstrument: async () => { throw new Error("not called") },
        },
        candles: {
          loadCandles: async () => { throw new Error("not called") },
        },
      },
      indexData: {
        loadIndexImpact: async () => { throw new Error("not called") },
      },
      shortSales: {
        listShortSales: async () => { throw new Error("not called") },
      },
      viopMargins: {
        listMarginCalls: async () => { throw new Error("not called") },
        listMarginRequirements: async () => { throw new Error("not called") },
      },
      brokerVolumes: {
        listBrokerVolumes: async () => { throw new Error("not called") },
      },
      stops: { list: async () => [] },
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "list_instruments",
    "list_viop_equity_financials",
    "get_viop_quote",
    "get_contract_details",
    "get_candles",
    "get_index_impact",
    "list_short_sales",
    "get_viop_margin_calls",
    "list_viop_margin_requirements",
    "list_broker_market_share",
    "get_account",
    "get_order_book",
    "get_equity_quote",
    "get_brokerage_distribution",
    "get_settlement",
    "list_news",
    "get_news_article",
    "list_pending_orders",
    "get_data_entitlements",
    "list_stop_rules",
    "subagent",
  ])
})

test("adds every permission-gated trading tool when the server provides them", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    trading: {
      sources: () => { throw new Error("not called") },
      permissions: { authorize: async () => ({ decision: "DENY", reason: null }) },
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "place_viop_order",
    "cancel_pending_viop_orders",
    "exit_viop_position",
    "exit_all_viop_positions",
    "subagent",
  ])
})

test("adds permission-gated protective exit tools when the server provides them", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    stopRules: {
      sources: () => { throw new Error("not called") },
      rules: {
        list: async () => [],
        save: async () => { throw new Error("not called") },
        setStatus: async () => {},
        remove: async () => {},
      },
      permissions: { authorize: async () => ({ decision: "DENY", reason: null }) },
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "create_stop_rule",
    "update_stop_rule",
    "set_stop_rule_status",
    "delete_stop_rule",
    "subagent",
  ])
})
