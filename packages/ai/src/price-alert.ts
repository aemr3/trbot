import { Type } from "@earendil-works/pi-ai"
import {
  isAtrAlert,
  validatePriceAlert,
  type PriceAlert,
  type PriceAlertActions,
  type PriceAlertBasis,
  type PriceAlertDraft,
  type PriceAlertKind,
  type PriceAlertRepeat,
} from "@trbot/market/alert.ts"
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

const Direction = Type.Union([Type.Literal("ABOVE"), Type.Literal("BELOW")])
const Kind = Type.Union([
  Type.Literal("PRICE"),
  Type.Literal("PERCENT"),
  Type.Literal("ATR"),
  Type.Literal("TRAILING_PERCENT"),
  Type.Literal("TRAILING_ATR"),
])
const Basis = Type.Union([Type.Literal("TOUCH"), Type.Literal("CLOSE")])
const Interval = Type.Union([
  Type.Literal("MIN_10"),
  Type.Literal("HOUR_1"),
  Type.Literal("HOUR_4"),
  Type.Literal("DAY_1"),
])
const Repeat = Type.Union([Type.Literal("ONCE"), Type.Literal("ALWAYS")])
const Status = Type.Union([Type.Literal("ARMED"), Type.Literal("PAUSED"), Type.Literal("TRIGGERED")])
const MutableStatus = Type.Union([Type.Literal("ARMED"), Type.Literal("PAUSED")])
const Continuation = Type.Union([
  Type.String({
    description: "Continuation to resume in this chat when the alert fires",
    minLength: 1,
    maxLength: 4_000,
  }),
  Type.Null({ description: "Remove the chat continuation and leave this as a popup-only alert" }),
])

const CreatePriceAlertParameters = Type.Object({
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
  onTrigger: Type.Optional(Type.String({
    description: [
      "Continuation to resume when the alert fires.",
      "State why this watch exists and what the agent should reconsider or do; omit for a popup-only alert.",
    ].join(" "),
    minLength: 1,
    maxLength: 4_000,
  })),
})

const ListPriceAlertsParameters = Type.Object({
  symbol: Type.Optional(Type.String({ description: "Only alerts for this contract or underlying symbol" })),
  status: Type.Optional(Status),
})

const UpdatePriceAlertParameters = Type.Object({
  id: Type.String({ description: "Alert ID returned by list_price_alerts", minLength: 1 }),
  symbol: Type.Optional(Type.String({ description: "Move the alert to this VIOP contract or underlying symbol" })),
  direction: Type.Optional(Direction),
  kind: Type.Optional(Kind),
  value: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  basis: Type.Optional(Basis),
  interval: Type.Optional(Interval),
  repeat: Type.Optional(Repeat),
  onTrigger: Type.Optional(Continuation),
})

const SetPriceAlertStatusParameters = Type.Object({
  id: Type.String({ description: "Alert ID returned by list_price_alerts", minLength: 1 }),
  status: MutableStatus,
})

const DeletePriceAlertParameters = Type.Object({
  id: Type.String({ description: "Alert ID returned by list_price_alerts", minLength: 1 }),
})

/** The same market and alert clients the terminal uses to prepare and save a draft. */
export interface PriceAlertToolClients {
  instruments: ViopInstrumentSource
  candles: CandleSource
  alerts: PriceAlertActions
  now?: () => number
}

/** Complete alert management surface shared by the parent agent and subagents. */
export function priceAlertTools(service: PriceAlertToolClients): ChatTool[] {
  return [
    createPriceAlertTool(service),
    listPriceAlertsTool(service),
    updatePriceAlertTool(service),
    setPriceAlertStatusTool(service),
    deletePriceAlertTool(service),
  ]
}

/** Creates any alert shape the market engine supports. */
export function createPriceAlertTool(service: PriceAlertToolClients): ChatTool<typeof CreatePriceAlertParameters> {
  return {
    definition: {
      name: "create_price_alert",
      description: [
        "Create a VIOP price alert using a fixed price, percent distance, ATR distance, or trailing distance.",
        "The server watches without consuming model tokens.",
        "Provide onTrigger to resume this conversation when it fires, or omit it for a popup-only alert.",
        "CLOSE and ATR alerts require an interval.",
      ].join(" "),
      parameters: CreatePriceAlertParameters,
    },
    run: async (args, options) => {
      const chatSessionId = requireChatSession(options)
      const instruments = await service.instruments.listInstruments({ signal: options.signal })
      const instrument = resolveViopInstrument(instruments, args.symbol)
      const kind = args.kind
      const basis = args.basis ?? "TOUCH"
      const interval = needsInterval(kind, basis) ? (args.interval ?? null) : null
      const continuation = cleanContinuation(args.onTrigger)
      const draft: PriceAlertDraft = {
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
        chatSessionId: continuation ? chatSessionId : null,
        onTrigger: continuation ?? null,
      }
      requireValidDraft(draft, instrument.lastPrice)
      const alert = await service.alerts.save(draft)
      return alertOutcome(`Created alert ${alert.id}: ${shortAlert(alert)}.`, alert)
    },
  }
}

function listPriceAlertsTool(service: PriceAlertToolClients): ChatTool<typeof ListPriceAlertsParameters> {
  return {
    definition: {
      name: "list_price_alerts",
      description: "List price alerts and their IDs, configuration, current level, status, ownership, and continuation.",
      parameters: ListPriceAlertsParameters,
    },
    run: async ({ symbol, status }) => {
      const wanted = symbol?.trim().toUpperCase()
      const alerts = (await service.alerts.list()).filter((alert) => (
        (!status || alert.status === status)
        && (!wanted || [alert.symbol, alert.displayName].some((name) => name.toUpperCase() === wanted))
      ))
      return {
        blocks: [toolText(`Found ${alerts.length} price alert${alerts.length === 1 ? "" : "s"}.`)],
        modelBlocks: [toolText(alerts.length === 0 ? "No matching price alerts." : alerts.map(fullAlert).join("\n\n"))],
        details: { alerts },
        isError: false,
      }
    },
  }
}

function updatePriceAlertTool(service: PriceAlertToolClients): ChatTool<typeof UpdatePriceAlertParameters> {
  return {
    definition: {
      name: "update_price_alert",
      description: [
        "Update and re-arm an existing price alert. Only supplied fields change.",
        "Changing onTrigger attaches the continuation to this chat; set it to null for a popup-only alert.",
        "Use list_price_alerts first when the ID or current configuration is unknown.",
      ].join(" "),
      parameters: UpdatePriceAlertParameters,
    },
    run: async (args, options) => {
      const chatSessionId = requireChatSession(options)
      const patch = compactUpdate(args)
      if (Object.keys(patch).length === 0) throw new Error("At least one alert field must be changed")
      const existing = await requireAlert(service, args.id)
      const instruments = await service.instruments.listInstruments({ signal: options.signal })
      const instrument = patch.symbol
        ? resolveViopInstrument(instruments, patch.symbol)
        : instruments.find((item) => item.uid === existing.instrumentUid)
      if (!instrument) throw new Error(`The contract for alert ${args.id} is no longer active`)
      const kind = patch.kind ?? existing.kind
      const basis = patch.basis ?? existing.basis
      const interval = needsInterval(kind, basis) ? (patch.interval ?? existing.interval) : null
      const continuation = patch.onTrigger === undefined
        ? {}
        : patch.onTrigger === null
          ? { chatSessionId: null, onTrigger: null }
          : { chatSessionId, onTrigger: patch.onTrigger }
      const draft: PriceAlertDraft = {
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
        ...continuation,
      }
      requireValidDraft(draft, instrument.lastPrice)
      const alert = await service.alerts.save(draft)
      return alertOutcome(`Updated alert ${alert.id}: ${shortAlert(alert)}.`, alert)
    },
  }
}

function setPriceAlertStatusTool(service: PriceAlertToolClients): ChatTool<typeof SetPriceAlertStatusParameters> {
  return {
    definition: {
      name: "set_price_alert_status",
      description: "Pause an alert or arm/re-arm it. Re-arming clears its previous trigger and waits for a fresh crossing.",
      parameters: SetPriceAlertStatusParameters,
    },
    run: async ({ id, status }, options) => {
      requireChatSession(options)
      await requireAlert(service, id)
      await service.alerts.setStatus(id, status)
      const alert = await requireAlert(service, id)
      return alertOutcome(`${status === "PAUSED" ? "Paused" : "Armed"} alert ${alert.id}.`, alert)
    },
  }
}

function deletePriceAlertTool(service: PriceAlertToolClients): ChatTool<typeof DeletePriceAlertParameters> {
  return {
    definition: {
      name: "delete_price_alert",
      description: "Permanently delete an existing price alert. Use list_price_alerts first when its ID is unknown.",
      parameters: DeletePriceAlertParameters,
    },
    run: async ({ id }, options) => {
      requireChatSession(options)
      const alert = await requireAlert(service, id)
      await service.alerts.remove(id)
      return {
        blocks: [toolText(`Deleted alert ${alert.id} for ${alert.displayName}.`)],
        modelBlocks: [toolText(`Deleted:\n${fullAlert(alert)}`)],
        details: { alert },
        isError: false,
      }
    },
  }
}

function requireChatSession(options: ChatToolRunOptions): string {
  if (!options.chatSessionId) throw new Error("Alert management must belong to a chat session")
  return options.chatSessionId
}

function cleanContinuation(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.trim() : value
}

interface AlertUpdatePatch {
  symbol?: string
  direction?: LevelDirection
  kind?: PriceAlertKind
  value?: number
  basis?: PriceAlertBasis
  interval?: CandleInterval
  repeat?: PriceAlertRepeat
  onTrigger?: string | null
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

async function requireAlert(service: PriceAlertToolClients, id: string): Promise<PriceAlert> {
  const alert = (await service.alerts.list()).find((item) => item.id === id)
  if (!alert) throw new Error(`No price alert found with ID ${id}`)
  return alert
}

function needsInterval(kind: PriceAlertKind, basis: PriceAlertBasis): boolean {
  return basis === "CLOSE" || isAtrAlert(kind)
}

async function readAtr(
  service: PriceAlertToolClients,
  instrumentUid: string,
  kind: PriceAlertKind,
  interval: CandleInterval | null,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!isAtrAlert(kind) || !interval) return null
  const range = futuresRangeForInterval(interval)
  if (!range) throw new Error(`${interval} is not available for VIOP alerts`)
  const series = await service.candles.loadCandles(instrumentUid, range, interval, {
    signal,
    target: "INSTRUMENT",
  })
  return averageTrueRange(closedCandles(series, service.now?.() ?? Date.now()), ATR_PERIOD)
}

function requireValidDraft(draft: PriceAlertDraft, lastPrice: number | null): void {
  const problem = validatePriceAlert(draft, lastPrice)
  if (problem) throw new Error(problem)
}

function alertOutcome(text: string, alert: PriceAlert) {
  return {
    blocks: [toolText(text)],
    modelBlocks: [toolText(fullAlert(alert))],
    details: { alert },
    isError: false,
  }
}

function shortAlert(alert: PriceAlert): string {
  const side = alert.direction === "ABOVE" ? "above" : "below"
  return `${alert.displayName} ${side} ${alert.triggerPrice ?? "unresolved"} (${alert.kind}, ${alert.status.toLowerCase()})`
}

function fullAlert(alert: PriceAlert): string {
  return [
    `id: ${alert.id}`,
    `contract: ${alert.symbol}`,
    `display_name: ${alert.displayName}`,
    `status: ${alert.status}`,
    `condition: ${alert.direction} ${alert.kind} ${alert.value}`,
    `current_trigger_price: ${alert.triggerPrice ?? "unresolved"}`,
    `basis: ${alert.basis}`,
    `interval: ${alert.interval ?? "none"}`,
    `repeat: ${alert.repeat}`,
    `owner_chat: ${alert.chatSessionId ?? "none"}`,
    `continuation: ${alert.onTrigger ?? "none"}`,
  ].join("\n")
}
