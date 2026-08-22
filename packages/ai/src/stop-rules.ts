import { Type } from "@earendil-works/pi-ai"
import {
  averageTrueRange,
  closedCandles,
  type CandleInterval,
  type CandleSource,
} from "@trbot/market/candle.ts"
import { resolveViopInstrument, type ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { AccountSource } from "@trbot/trading/account.ts"
import {
  createStopRule,
  isAtrStopRule,
  resolveStopLevel,
  stopPositionSide,
  validateStopRule,
  type StopRule,
  type StopRuleBasis,
  type StopRuleDraft,
  type StopRuleKind,
  type StopRuleRole,
  type StopRuleStatus,
} from "@trbot/trading/stop.ts"
import { rangeForInterval } from "@trbot/trading/stop-monitor.ts"
import { requireToolPermission, type ChatPermissionAuthorizer } from "./permission.ts"
import { toolText, type ChatTool, type ChatToolOutcome } from "./tool.ts"

const ATR_PERIOD = 14

const SymbolParameter = Type.String({
  description: "Open VIOP position, given by its contract or underlying symbol, such as F_ASELS0826 or ASELS",
  minLength: 1,
  maxLength: 80,
})
const RuleIdParameter = Type.String({
  description: "Rule ID returned by list_stop_rules",
  minLength: 1,
  maxLength: 100,
})
const ReasonParameter = Type.Optional(Type.String({
  description: "Brief reason this change is needed",
  minLength: 1,
  maxLength: 1_000,
}))
const RoleParameter = Type.Union([Type.Literal("STOP"), Type.Literal("TARGET")], {
  description: "STOP limits loss; TARGET takes profit",
})
const KindParameter = Type.Union([
  Type.Literal("PRICE"),
  Type.Literal("PERCENT"),
  Type.Literal("ATR"),
  Type.Literal("TRAILING_PERCENT"),
  Type.Literal("TRAILING_ATR"),
], {
  description: "How to calculate the level: PRICE is absolute; PERCENT and ATR are fixed distances from average entry; TRAILING_PERCENT and TRAILING_ATR follow favorable movement",
})
const BasisParameter = Type.Union([Type.Literal("TOUCH"), Type.Literal("CLOSE")], {
  description: "TOUCH reacts to a live trade; CLOSE ignores wicks and waits for a completed candle beyond the level. New rules default to TOUCH when omitted",
})
const IntervalParameter = Type.Union([
  Type.Literal("MIN_1"),
  Type.Literal("MIN_5"),
  Type.Literal("MIN_15"),
  Type.Literal("MIN_30"),
  Type.Literal("HOUR_1"),
  Type.Literal("HOUR_4"),
  Type.Literal("DAY_1"),
  Type.Literal("WEEK_1"),
], { description: "Candle timeframe used for CLOSE triggers and ATR calculation; required for CLOSE, ATR, and TRAILING_ATR rules" })

const ValueParameter = Type.Number({
  description: "PRICE: absolute contract price. PERCENT or TRAILING_PERCENT: percentage distance. ATR or TRAILING_ATR: ATR multiple",
  exclusiveMinimum: 0,
})

const CreateStopRuleParameters = Type.Object({
  symbol: SymbolParameter,
  role: RoleParameter,
  kind: KindParameter,
  value: ValueParameter,
  basis: Type.Optional(BasisParameter),
  interval: Type.Optional(IntervalParameter),
  quantity: Type.Optional(Type.Integer({
    description: "Contracts to exit when triggered; omit to exit the complete remaining position",
    minimum: 1,
  })),
  reason: ReasonParameter,
})

const UpdateStopRuleParameters = Type.Object({
  id: RuleIdParameter,
  role: Type.Optional(RoleParameter),
  kind: Type.Optional(KindParameter),
  value: Type.Optional(ValueParameter),
  basis: Type.Optional(BasisParameter),
  interval: Type.Optional(Type.Union([IntervalParameter, Type.Null()])),
  quantity: Type.Optional(Type.Union([
    Type.Integer({ description: "Contracts to exit", minimum: 1 }),
    Type.Null({ description: "Exit the complete remaining position" }),
  ])),
  reason: ReasonParameter,
})

const SetStopRuleStatusParameters = Type.Object({
  id: RuleIdParameter,
  status: Type.Union([Type.Literal("ARMED"), Type.Literal("PAUSED")]),
  reason: ReasonParameter,
})

const DeleteStopRuleParameters = Type.Object({
  id: RuleIdParameter,
  reason: ReasonParameter,
})

export interface StopRuleMutationActions {
  list(): Promise<StopRule[]>
  save(draft: StopRuleDraft): Promise<StopRule>
  setStatus(id: string, status: StopRuleStatus): Promise<void>
  remove(id: string): Promise<void>
}

export interface StopRuleToolSources {
  instruments: ViopInstrumentSource
  account: AccountSource
  candles: CandleSource
}

export interface StopRuleToolClients {
  sources(): StopRuleToolSources
  rules: StopRuleMutationActions
  permissions: ChatPermissionAuthorizer
  now?: () => number
}

/** Permission-gated management for server-side rules that can submit future exits. */
export function stopRuleTools(service: StopRuleToolClients): ChatTool[] {
  return [
    createStopRuleTool(service),
    updateStopRuleTool(service),
    setStopRuleStatusTool(service),
    deleteStopRuleTool(service),
  ]
}

function createStopRuleTool(service: StopRuleToolClients): ChatTool<typeof CreateStopRuleParameters> {
  return {
    definition: {
      name: "create_stop_rule",
      description: [
        "Create a durable server-managed protective STOP or profit TARGET for an open VIOP position.",
        "This is not a broker-native resting stop order: trbot watches the contract, starts an exit countdown when triggered, and submits a marketable limit exit unless the user holds or cancels it.",
        "PRICE uses value as an absolute contract price. PERCENT uses a percentage distance from average entry. ATR uses an ATR multiple from average entry. TRAILING_PERCENT and TRAILING_ATR follow favorable movement by the specified percentage or ATR multiple.",
        "basis defaults to TOUCH. CLOSE ignores wicks and triggers only after a completed candle closes beyond the level. CLOSE, ATR, and TRAILING_ATR require interval. Omitted quantity protects the complete remaining position.",
      ].join(" "),
      parameters: CreateStopRuleParameters,
    },
    run: async (args, options) => {
      const now = service.now?.() ?? Date.now()
      const configuration: StopConfiguration = {
        role: args.role,
        kind: args.kind,
        value: args.value,
        basis: args.basis ?? "TOUCH",
        interval: args.interval ?? null,
        quantity: args.quantity ?? null,
      }
      const proposed = await buildDraft(service.sources(), args.symbol, configuration, undefined, now, options.signal)
      const action = `Create ${ruleSummary(proposed.preview)}; it may submit a future VIOP exit`
      await requireToolPermission(service.permissions, options, "create_stop_rule", action, args.reason)

      const refreshed = await buildDraft(
        service.sources(),
        args.symbol,
        configuration,
        undefined,
        service.now?.() ?? Date.now(),
        options.signal,
      )
      requireUnchangedDraft(proposed.draft, refreshed.draft)
      const rule = await service.rules.save(refreshed.draft)
      return ruleOutcome(`Created stop rule ${rule.id}: ${ruleSummary(rule)}.`, rule)
    },
  }
}

function updateStopRuleTool(service: StopRuleToolClients): ChatTool<typeof UpdateStopRuleParameters> {
  return {
    definition: {
      name: "update_stop_rule",
      description: [
        "Update and re-arm a durable VIOP stop or target rule. Only supplied fields change.",
        "Use list_stop_rules first. Editing replaces its working level and clears its prior trigger state.",
        "This can change a future automatic exit.",
      ].join(" "),
      parameters: UpdateStopRuleParameters,
    },
    run: async (args, options) => {
      const now = service.now?.() ?? Date.now()
      const existing = requireRule(await service.rules.list(), args.id)
      const configuration: StopConfiguration = {
        role: args.role ?? existing.role,
        kind: args.kind ?? existing.kind,
        value: args.value ?? existing.value,
        basis: args.basis ?? existing.basis,
        interval: args.interval === undefined ? existing.interval : args.interval,
        quantity: args.quantity === undefined ? existing.quantity : args.quantity,
      }
      const proposed = await buildDraft(
        service.sources(),
        existing.symbol,
        configuration,
        existing.id,
        now,
        options.signal,
      )
      const action = `Replace stop rule ${existing.id} (${ruleSummary(existing)}) with ${ruleSummary(proposed.preview)}`
      await requireToolPermission(service.permissions, options, "update_stop_rule", action, args.reason)

      const current = requireRule(await service.rules.list(), args.id)
      requireUnchangedRule(existing, current)
      const refreshed = await buildDraft(
        service.sources(),
        current.symbol,
        configuration,
        current.id,
        service.now?.() ?? Date.now(),
        options.signal,
      )
      requireUnchangedDraft(proposed.draft, refreshed.draft)
      const rule = await service.rules.save(refreshed.draft)
      return ruleOutcome(`Updated stop rule ${rule.id}: ${ruleSummary(rule)}.`, rule)
    },
  }
}

function setStopRuleStatusTool(service: StopRuleToolClients): ChatTool<typeof SetStopRuleStatusParameters> {
  return {
    definition: {
      name: "set_stop_rule_status",
      description: [
        "Pause or arm a server-managed VIOP stop or target rule after reading it with list_stop_rules.",
        "Pausing a triggered rule cancels its pending exit countdown. Arming starts its market-side safety latch again.",
      ].join(" "),
      parameters: SetStopRuleStatusParameters,
    },
    run: async ({ id, status, reason }, options) => {
      const rule = requireRule(await service.rules.list(), id)
      if (rule.status === "DONE") throw new Error("A completed stop rule cannot be armed or paused")
      const consequence = status === "PAUSED" && rule.status === "TRIGGERED"
        ? "; cancel its pending exit countdown"
        : ""
      await requireToolPermission(
        service.permissions,
        options,
        "set_stop_rule_status",
        `${status === "ARMED" ? "Arm" : "Pause"} stop rule ${id}: ${ruleSummary(rule)}${consequence}`,
        reason,
      )
      const current = requireRule(await service.rules.list(), id)
      requireUnchangedRule(rule, current)
      await service.rules.setStatus(id, status)
      const updated = requireRule(await service.rules.list(), id)
      return ruleOutcome(`${status === "ARMED" ? "Armed" : "Paused"} stop rule ${id}.`, updated)
    },
  }
}

function deleteStopRuleTool(service: StopRuleToolClients): ChatTool<typeof DeleteStopRuleParameters> {
  return {
    definition: {
      name: "delete_stop_rule",
      description: [
        "Permanently delete a server-managed VIOP stop or target rule after reading it with list_stop_rules.",
        "Deleting a triggered rule also cancels its pending exit countdown.",
      ].join(" "),
      parameters: DeleteStopRuleParameters,
    },
    run: async ({ id, reason }, options) => {
      const rule = requireRule(await service.rules.list(), id)
      const consequence = rule.status === "TRIGGERED" ? "; cancel its pending exit countdown" : ""
      await requireToolPermission(
        service.permissions,
        options,
        "delete_stop_rule",
        `Delete stop rule ${id}: ${ruleSummary(rule)}${consequence}`,
        reason,
      )
      const current = requireRule(await service.rules.list(), id)
      requireUnchangedRule(rule, current)
      await service.rules.remove(id)
      return ruleOutcome(`Deleted stop rule ${id}.`, current)
    },
  }
}

interface StopConfiguration {
  role: StopRuleRole
  kind: StopRuleKind
  value: number
  basis: StopRuleBasis
  interval: CandleInterval | null
  quantity: number | null
}

interface BuiltDraft {
  draft: StopRuleDraft
  preview: StopRule
}

async function buildDraft(
  sources: StopRuleToolSources,
  symbol: string,
  configuration: StopConfiguration,
  id: string | undefined,
  now: number,
  signal?: AbortSignal,
): Promise<BuiltDraft> {
  const [instruments, account] = await Promise.all([
    sources.instruments.listInstruments({ signal }),
    sources.account.loadAccount({ signal }),
  ])
  const instrument = resolveViopInstrument(instruments, symbol)
  const position = account.positions.find((entry) => entry.uid === instrument.uid || entry.symbol === instrument.symbol)
  if (!position || position.quantity === 0) throw new Error(`There is no open position in ${instrument.symbol}`)
  const openQuantity = Math.abs(position.quantity)
  if (configuration.quantity !== null && configuration.quantity > openQuantity) {
    throw new Error(`Only ${openQuantity} contracts are open in ${instrument.symbol}`)
  }

  const needsInterval = configuration.basis === "CLOSE" || isAtrStopRule(configuration.kind)
  const interval = needsInterval ? configuration.interval : null
  if (needsInterval && !interval) throw new Error("CLOSE and ATR stop rules require an interval")

  let series = null
  if (isAtrStopRule(configuration.kind) || position.currentPrice === null && instrument.lastPrice === null) {
    const candleInterval = interval ?? "MIN_5"
    series = await sources.candles.loadCandles(instrument.uid, rangeForInterval(candleInterval), candleInterval, {
      signal,
      target: "INSTRUMENT",
    })
  }
  let atrValue = null
  if (isAtrStopRule(configuration.kind)) {
    if (!series) throw new Error(`Candles are unavailable for ${instrument.symbol}`)
    atrValue = averageTrueRange(closedCandles(series, now), ATR_PERIOD)
  }
  if (isAtrStopRule(configuration.kind) && atrValue === null) {
    throw new Error(`ATR is unavailable for ${instrument.symbol} at ${interval}`)
  }
  const lastPrice = position.currentPrice ?? instrument.lastPrice ?? series?.candles.at(-1)?.close ?? null
  if (lastPrice === null) throw new Error(`Current price is unavailable for ${instrument.symbol}`)

  const draft: StopRuleDraft = {
    instrumentUid: instrument.uid,
    symbol: instrument.symbol,
    displayName: position.displayName || instrument.displayName,
    side: stopPositionSide(position.quantity),
    role: configuration.role,
    kind: configuration.kind,
    value: configuration.value,
    basis: configuration.basis,
    interval,
    quantity: configuration.quantity,
    referencePrice: position.averageCost,
    atrValue,
  }
  if (id) draft.id = id
  const invalid = validateStopRule(draft, lastPrice)
  if (invalid) throw new Error(invalid)
  const preview = createStopRule({ ...draft, id: id ?? "preview" }, now)
  return { draft, preview }
}

function requireRule(rules: StopRule[], id: string): StopRule {
  const rule = rules.find((entry) => entry.id === id)
  if (!rule) throw new Error(`No stop rule found with id ${id}`)
  return rule
}

function requireUnchangedDraft(before: StopRuleDraft, after: StopRuleDraft): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("The protected position or ATR changed while permission was pending; inspect it and try again")
  }
}

function requireUnchangedRule(before: StopRule, after: StopRule): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("The stop rule changed while permission was pending; inspect it and try again")
  }
}

function ruleSummary(rule: StopRule): string {
  const level = resolveStopLevel(rule)
  const quantity = rule.quantity === null ? "all remaining contracts" : `${rule.quantity} contract${rule.quantity === 1 ? "" : "s"}`
  const basis = rule.basis === "CLOSE" ? `${rule.interval} close` : "touch"
  return `${rule.role} ${rule.symbol} at ${level ?? "unresolved"} (${basis}, ${quantity})`
}

function ruleOutcome<T>(text: string, details: T): ChatToolOutcome {
  return {
    blocks: [toolText(text)],
    modelBlocks: [toolText(JSON.stringify(details))],
    details,
    isError: false,
  }
}
