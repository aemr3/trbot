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

test("adds interactive questions to the complete parent and subagent toolset", () => {
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

test("adds non-blocking user notifications to the complete parent and subagent toolset", () => {
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

  const tools = createAgentTools({ models, automations: {} as never })

  expect(tools.list().map((tool) => tool.name)).toEqual([
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
})

test("adds every read-only market tool when the server provides its clients", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    marketData: {
      sources: () => { throw new Error("not called") },
      stops: { list: async () => [] },
    },
  })

  expect(tools.list().map((tool) => tool.name)).toEqual([
    "web_search",
    "fetch_content",
    "list_instruments",
    "get_viop_quote",
    "get_contract_details",
    "get_candles",
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
