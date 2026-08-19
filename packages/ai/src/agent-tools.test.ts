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

test("adds the durable price watch when the server provides it", () => {
  const faux = fauxProvider({ models: [{ id: "chat-model" }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const tools = createAgentTools({
    models,
    priceAlerts: {
      instruments: { listInstruments: async () => [] },
      candles: { loadCandles: async () => { throw new Error("not called") } },
      alerts: {
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
    "create_price_alert",
    "list_price_alerts",
    "update_price_alert",
    "set_price_alert_status",
    "delete_price_alert",
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
