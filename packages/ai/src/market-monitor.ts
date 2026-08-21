import { Type } from "@earendil-works/pi-ai"
import {
  isAtrAlert,
  validatePriceAlert,
  type PriceAlertBasis,
  type PriceAlertKind,
  type PriceAlertRepeat,
} from "@trbot/market/alert.ts"
import type {
  MarketMonitor,
  MarketMonitorActions,
  MarketMonitorDraft,
} from "@trbot/market/market-monitor.ts"
import {
  averageTrueRange,
  closedCandles,
  futuresRangeForInterval,
  type CandleInterval,
  type CandleSource,
} from "@trbot/market/candle.ts"
import { resolveViopInstrument, type ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { LevelDirection } from "@trbot/market/price-level.ts"
import { toolText, type ChatTool, type ChatToolRunOptions } from "./tool.ts"

const ATR_PERIOD = 14

const Direction = Type.Union([Type.Literal("ABOVE"), Type.Literal("BELOW")], {
  description: "ABOVE triggers on a crossing up through the level; BELOW triggers on a crossing down through it",
})
const Kind = Type.Union([
  Type.Literal("PRICE"),
  Type.Literal("PERCENT"),
  Type.Literal("ATR"),
  Type.Literal("TRAILING_PERCENT"),
  Type.Literal("TRAILING_ATR"),
], {
  description: "How the trigger level is derived: fixed PRICE, standing PERCENT/ATR distance, or a trailing distance",
})
const Basis = Type.Union([Type.Literal("TOUCH"), Type.Literal("CLOSE")], {
  description: "TOUCH reacts to a live trade crossing; CLOSE waits for a completed candle beyond the level",
})
const Interval = Type.Union([
  Type.Literal("MIN_10"),
  Type.Literal("HOUR_1"),
  Type.Literal("HOUR_4"),
  Type.Literal("DAY_1"),
], { description: "Completed-candle timeframe for CLOSE monitors and ATR measurement" })
const Repeat = Type.Union([Type.Literal("ONCE"), Type.Literal("ALWAYS")], {
  description: "ONCE stops after triggering; ALWAYS re-arms after price returns to the near side and crosses again",
})
const Status = Type.Union([Type.Literal("ARMED"), Type.Literal("PAUSED"), Type.Literal("TRIGGERED")])
const MutableStatus = Type.Union([Type.Literal("ARMED"), Type.Literal("PAUSED")])
const CreateMarketMonitorParameters = Type.Object({
  symbol: Type.String({
    description: "VIOP contract to watch, given by its contract symbol or underlying symbol, such as F_ASELS0826 or ASELS",
    minLength: 1,
    maxLength: 80,
  }),
  direction: Direction,
  kind: Kind,
  value: Type.Number({
    description: "Trigger price for PRICE, percentage distance for PERCENT kinds, or ATR multiple for ATR kinds",
    exclusiveMinimum: 0,
  }),
  basis: Type.Optional(Basis),
  interval: Type.Optional(Interval),
  repeat: Type.Optional(Repeat),
  onTrigger: Type.String({
    description: [
      "Self-contained continuation for the agent when this monitor triggers.",
      "State why the monitor exists, which fresh market and account data to read, and what to reassess.",
      "A trigger is only a signal; refresh current data before acting.",
    ].join(" "),
    minLength: 1,
    maxLength: 4_000,
  }),
})

const ListMarketMonitorsParameters = Type.Object({
  symbol: Type.Optional(Type.String({ description: "Only monitors for this contract or underlying symbol" })),
  status: Type.Optional(Status),
})

const UpdateMarketMonitorParameters = Type.Object({
  id: Type.String({ description: "Monitor ID returned by list_market_monitors", minLength: 1 }),
  symbol: Type.Optional(Type.String({ description: "Move the monitor to this VIOP contract or underlying symbol" })),
  direction: Type.Optional(Direction),
  kind: Type.Optional(Kind),
  value: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  basis: Type.Optional(Basis),
  interval: Type.Optional(Interval),
  repeat: Type.Optional(Repeat),
  onTrigger: Type.Optional(Type.String({
    description: "Replace the continuation used to resume this chat when the monitor triggers",
    minLength: 1,
    maxLength: 4_000,
  })),
})

const SetMarketMonitorStatusParameters = Type.Object({
  id: Type.String({ description: "Monitor ID returned by list_market_monitors", minLength: 1 }),
  status: MutableStatus,
})

const CancelMarketMonitorParameters = Type.Object({
  id: Type.String({ description: "Monitor ID returned by list_market_monitors", minLength: 1 }),
})

/** Agent market data plus the independent durable monitor controller. */
export interface MarketMonitorToolClients {
  instruments: ViopInstrumentSource
  candles: CandleSource
  monitors: MarketMonitorActions
  now?: () => number
}

/** Complete market-monitor management surface shared by the parent agent and subagents. */
export function marketMonitorTools(service: MarketMonitorToolClients): ChatTool[] {
  return [
    createMarketMonitorTool(service),
    listMarketMonitorsTool(service),
    updateMarketMonitorTool(service),
    setMarketMonitorStatusTool(service),
    cancelMarketMonitorTool(service),
  ]
}

/** Creates any price or candle monitor shape the market engine supports. */
export function createMarketMonitorTool(
  service: MarketMonitorToolClients,
): ChatTool<typeof CreateMarketMonitorParameters> {
  return {
    definition: {
      name: "create_market_monitor",
      description: [
        "Create a durable server-side VIOP market monitor using a fixed price, percent distance, ATR distance, or trailing distance.",
        "The server evaluates it without consuming model tokens and it remains active when no terminal is attached.",
        "onTrigger is the continuation used to wake the originating chat when it triggers.",
        "A triggered agent must refresh the required market and account data before analysis or action because the event is not current data.",
        "This tool only creates the monitor; it does not place orders.",
        "CLOSE and ATR monitors require an interval.",
      ].join(" "),
      parameters: CreateMarketMonitorParameters,
    },
    run: async (args, options) => {
      const chatSessionId = requireChatSession(options)
      const instruments = await service.instruments.listInstruments({ signal: options.signal })
      const instrument = resolveViopInstrument(instruments, args.symbol)
      const kind = args.kind
      const basis = args.basis ?? "TOUCH"
      const interval = needsInterval(kind, basis) ? (args.interval ?? null) : null
      const draft: MarketMonitorDraft = {
        instrumentUid: instrument.uid,
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        direction: args.direction,
        kind,
        value: args.value,
        basis,
        interval,
        repeat: args.repeat ?? "ONCE",
        referencePrice: instrument.lastPrice,
        atrValue: await readAtr(service, instrument.uid, kind, interval, options.signal),
        chatSessionId,
        onTrigger: args.onTrigger.trim(),
      }
      requireValidDraft(draft, instrument.lastPrice)
      const alert = await service.monitors.save(draft)
      return monitorOutcome(`Created market monitor ${alert.id}: ${shortMonitor(alert)}.`, alert)
    },
  }
}

function listMarketMonitorsTool(
  service: MarketMonitorToolClients,
): ChatTool<typeof ListMarketMonitorsParameters> {
  return {
    definition: {
      name: "list_market_monitors",
      description: [
        "List active, paused, and triggered market monitors with their IDs, conditions, status, owner chat, and continuation.",
        "Use this before updating or cancelling a monitor when its ID is unknown.",
      ].join(" "),
      parameters: ListMarketMonitorsParameters,
    },
    run: async ({ symbol, status }, options) => {
      const wanted = symbol?.trim().toUpperCase()
      const chatSessionId = requireChatSession(options)
      const monitors = (await service.monitors.list()).filter((monitor) => (
        monitor.chatSessionId === chatSessionId
        && (!status || monitor.status === status)
        && (!wanted || [monitor.symbol, monitor.displayName].some((name) => name.toUpperCase() === wanted))
      ))
      return {
        blocks: [toolText(`Found ${monitors.length} market monitor${monitors.length === 1 ? "" : "s"}.`)],
        modelBlocks: [toolText(monitors.length === 0 ? "No matching market monitors." : monitors.map(fullMonitor).join("\n\n"))],
        details: { monitors },
        isError: false,
      }
    },
  }
}

function updateMarketMonitorTool(
  service: MarketMonitorToolClients,
): ChatTool<typeof UpdateMarketMonitorParameters> {
  return {
    definition: {
      name: "update_market_monitor",
      description: [
        "Update and re-arm an existing market monitor. Only supplied fields change.",
        "Changing onTrigger replaces the continuation used to resume this chat.",
        "The continuation must require fresh market and account data before any decision or action.",
        "This tool only updates the monitor; it does not place orders.",
        "Use list_market_monitors first when the ID or current configuration is unknown.",
      ].join(" "),
      parameters: UpdateMarketMonitorParameters,
    },
    run: async (args, options) => {
      const chatSessionId = requireChatSession(options)
      const patch = compactUpdate(args)
      if (Object.keys(patch).length === 0) throw new Error("At least one monitor field must be changed")
      const existing = await requireMonitor(service, args.id, chatSessionId)
      const instruments = await service.instruments.listInstruments({ signal: options.signal })
      const instrument = patch.symbol
        ? resolveViopInstrument(instruments, patch.symbol)
        : instruments.find((item) => item.uid === existing.instrumentUid)
      if (!instrument) throw new Error(`The contract for monitor ${args.id} is no longer active`)
      const kind = patch.kind ?? existing.kind
      const basis = patch.basis ?? existing.basis
      const interval = needsInterval(kind, basis) ? (patch.interval ?? existing.interval) : null
      const draft: MarketMonitorDraft = {
        id: existing.id,
        instrumentUid: instrument.uid,
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        direction: patch.direction ?? existing.direction,
        kind,
        value: patch.value ?? existing.value,
        basis,
        interval,
        repeat: patch.repeat ?? existing.repeat,
        referencePrice: instrument.lastPrice,
        atrValue: await readAtr(service, instrument.uid, kind, interval, options.signal),
        chatSessionId,
        onTrigger: patch.onTrigger ?? existing.onTrigger,
      }
      requireValidDraft(draft, instrument.lastPrice)
      const alert = await service.monitors.save(draft)
      return monitorOutcome(`Updated market monitor ${alert.id}: ${shortMonitor(alert)}.`, alert)
    },
  }
}

function setMarketMonitorStatusTool(
  service: MarketMonitorToolClients,
): ChatTool<typeof SetMarketMonitorStatusParameters> {
  return {
    definition: {
      name: "set_market_monitor_status",
      description: "Pause a market monitor or arm/re-arm it. Re-arming clears its previous trigger and waits for a fresh crossing.",
      parameters: SetMarketMonitorStatusParameters,
    },
    run: async ({ id, status }, options) => {
      const chatSessionId = requireChatSession(options)
      await requireMonitor(service, id, chatSessionId)
      await service.monitors.setStatus(id, status)
      const alert = await requireMonitor(service, id, chatSessionId)
      return monitorOutcome(`${status === "PAUSED" ? "Paused" : "Armed"} market monitor ${alert.id}.`, alert)
    },
  }
}

function cancelMarketMonitorTool(
  service: MarketMonitorToolClients,
): ChatTool<typeof CancelMarketMonitorParameters> {
  return {
    definition: {
      name: "cancel_market_monitor",
      description: [
        "Permanently cancel and remove a market monitor so it can no longer trigger.",
        "Use list_market_monitors first when its ID is unknown.",
      ].join(" "),
      parameters: CancelMarketMonitorParameters,
    },
    run: async ({ id }, options) => {
      const chatSessionId = requireChatSession(options)
      const alert = await requireMonitor(service, id, chatSessionId)
      await service.monitors.remove(id)
      return {
        blocks: [toolText(`Cancelled market monitor ${alert.id} for ${alert.displayName}.`)],
        modelBlocks: [toolText(`Cancelled:\n${fullMonitor(alert)}`)],
        details: { monitor: alert },
        isError: false,
      }
    },
  }
}

function requireChatSession(options: ChatToolRunOptions): string {
  if (!options.chatSessionId) throw new Error("Market monitor management must belong to a chat session")
  return options.chatSessionId
}

function cleanContinuation(value: string | undefined): string | undefined {
  return value?.trim()
}

interface AlertUpdatePatch {
  symbol?: string
  direction?: LevelDirection
  kind?: PriceAlertKind
  value?: number
  basis?: PriceAlertBasis
  interval?: CandleInterval
  repeat?: PriceAlertRepeat
  onTrigger?: string
}

function compactUpdate(args: AlertUpdatePatch): AlertUpdatePatch {
  const patch: AlertUpdatePatch = {}
  if (args.symbol !== undefined) patch.symbol = args.symbol.trim()
  if (args.direction !== undefined) patch.direction = args.direction
  if (args.kind !== undefined) patch.kind = args.kind
  if (args.value !== undefined) patch.value = args.value
  if (args.basis !== undefined) patch.basis = args.basis
  if (args.interval !== undefined) patch.interval = args.interval
  if (args.repeat !== undefined) patch.repeat = args.repeat
  if (args.onTrigger !== undefined) patch.onTrigger = cleanContinuation(args.onTrigger)
  return patch
}

async function requireMonitor(
  service: MarketMonitorToolClients,
  id: string,
  chatSessionId: string,
): Promise<MarketMonitor> {
  const alert = (await service.monitors.list()).find((item) => item.id === id)
  if (!alert || alert.chatSessionId !== chatSessionId) throw new Error(`No market monitor found with ID ${id}`)
  return alert
}

function needsInterval(kind: PriceAlertKind, basis: PriceAlertBasis): boolean {
  return basis === "CLOSE" || isAtrAlert(kind)
}

async function readAtr(
  service: MarketMonitorToolClients,
  instrumentUid: string,
  kind: PriceAlertKind,
  interval: CandleInterval | null,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!isAtrAlert(kind) || !interval) return null
  const range = futuresRangeForInterval(interval)
  if (!range) throw new Error(`${interval} is not available for VIOP market monitors`)
  const series = await service.candles.loadCandles(instrumentUid, range, interval, {
    signal,
    target: "INSTRUMENT",
  })
  return averageTrueRange(closedCandles(series, service.now?.() ?? Date.now()), ATR_PERIOD)
}

function requireValidDraft(draft: MarketMonitorDraft, lastPrice: number | null): void {
  const problem = validatePriceAlert(draft, lastPrice)
  if (problem) throw new Error(problem)
}

function monitorOutcome(text: string, alert: MarketMonitor) {
  return {
    blocks: [toolText(text)],
    modelBlocks: [toolText(fullMonitor(alert))],
    details: { monitor: alert },
    isError: false,
  }
}

function shortMonitor(alert: MarketMonitor): string {
  const side = alert.direction === "ABOVE" ? "above" : "below"
  return `${alert.displayName} ${side} ${alert.triggerPrice ?? "unresolved"} (${alert.kind}, ${alert.status.toLowerCase()})`
}

function fullMonitor(alert: MarketMonitor): string {
  return [
    `monitor_id: ${alert.id}`,
    `contract: ${alert.symbol}`,
    `display_name: ${alert.displayName}`,
    `status: ${alert.status}`,
    `condition: ${alert.direction} ${alert.kind} ${alert.value}`,
    `current_trigger_price: ${alert.triggerPrice ?? "unresolved"}`,
    `basis: ${alert.basis}`,
    `interval: ${alert.interval ?? "none"}`,
    `repeat: ${alert.repeat}`,
    `owner_chat: ${alert.chatSessionId}`,
    `continuation: ${alert.onTrigger}`,
  ].join("\n")
}
