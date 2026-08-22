import { Type } from "@earendil-works/pi-ai"
import { resolveViopInstrument, type ViopInstrumentSource } from "@trbot/market/instrument.ts"
import type { AccountSource } from "@trbot/trading/account.ts"
import {
  resolveViopOrderPrice,
  viopRequiredOrderCollateral,
  type ViopOrderCancellationSource,
  type ViopOrderSource,
  type ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { requireToolPermission, type ChatPermissionAuthorizer } from "./permission.ts"
import { externalToolEffect, toolText, type ChatTool, type ChatToolOutcome } from "./tool.ts"

const SymbolParameter = Type.String({
  description: "Exact nearest-expiry VIOP contract returned by list_instruments, or its unambiguous underlying symbol; never construct an expiry code",
  minLength: 1,
  maxLength: 80,
})
const ReasonParameter = Type.Optional(Type.String({
  description: "Brief reason this action is needed",
  minLength: 1,
  maxLength: 1_000,
}))
const OrderKindParameter = Type.Union([Type.Literal("LIMIT"), Type.Literal("MARKETABLE_LIMIT")])

const PlaceOrderParameters = Type.Object({
  symbol: SymbolParameter,
  side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
  quantity: Type.Integer({ description: "Positive whole number of contracts", minimum: 1 }),
  orderKind: OrderKindParameter,
  limitPrice: Type.Optional(Type.Number({
    description: "Required for LIMIT; omit for MARKETABLE_LIMIT, which uses the live far exchange limit",
    exclusiveMinimum: 0,
  })),
  reason: ReasonParameter,
})
const CancelOrdersParameters = Type.Object({
  orderUids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: ReasonParameter,
})
const ExitPositionParameters = Type.Object({
  symbol: SymbolParameter,
  quantity: Type.Optional(Type.Integer({
    description: "Contracts to close; omit to close the complete current position",
    minimum: 1,
  })),
  reason: ReasonParameter,
})
const ExitAllParameters = Type.Object({ reason: ReasonParameter })

export interface TradingToolSources {
  instruments: ViopInstrumentSource
  account: AccountSource
  orders: ViopOrderSource & ViopOrderCancellationSource & ViopPositionExitSource
}

export interface TradingToolClients {
  /** Resolved per call because provider recovery replaces every source object. */
  sources(): TradingToolSources
  permissions: ChatPermissionAuthorizer
}

/** Live order mutations. Every path crosses the session permission gate first. */
export function tradingTools(clients: TradingToolClients): ChatTool[] {
  return [
    placeOrderTool(clients),
    cancelOrdersTool(clients),
    exitPositionTool(clients),
    exitAllPositionsTool(clients),
  ]
}

function placeOrderTool(clients: TradingToolClients): ChatTool<typeof PlaceOrderParameters> {
  return {
    definition: {
      name: "place_viop_order",
      description: [
        "Place one live VIOP day order after validating exchange limits and collateral.",
        "LIMIT requires limitPrice. MARKETABLE_LIMIT submits at the live far exchange limit and may remain unfilled.",
        "This moves money. State the reason when it helps explain the action.",
      ].join(" "),
      parameters: PlaceOrderParameters,
    },
    run: async ({ symbol, side, quantity, orderKind, limitPrice, reason }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const preparation = await sources.orders.prepareOrder({
        instrumentUid: instrument.uid,
        side,
        signal: options.signal,
      })
      const price = resolveViopOrderPrice(orderKind, side, limitPrice ?? null, preparation)
      if (price === null) {
        throw new Error(orderKind === "LIMIT" ? "A valid limit price is required" : "The exchange price limit is unavailable")
      }
      if (preparation.lowerLimit !== null && price < preparation.lowerLimit) {
        throw new Error("Limit price is below the exchange lower limit")
      }
      if (preparation.upperLimit !== null && price > preparation.upperLimit) {
        throw new Error("Limit price is above the exchange upper limit")
      }
      const required = viopRequiredOrderCollateral(
        quantity,
        preparation.initialCollateral,
        preparation.currentPositionQuantity,
        side,
      )
      if (required !== null && preparation.availableCollateral !== null && required > preparation.availableCollateral) {
        throw new Error("Available collateral is insufficient for this order")
      }
      const action = `${side} ${quantity} ${instrument.symbol} at ${price} (${orderKind})`
      await requireToolPermission(clients.permissions, options, "place_viop_order", action, reason)
      const order = await sources.orders.placeOrder({
        instrumentUid: instrument.uid,
        side,
        quantity,
        limitPrice: price,
        signal: options.signal,
      })
      return success(
        `Placed ${action}. Order ${order.uid} is ${order.status}.`,
        { instrument, order, price, orderKind },
        `VIOP order ${order.uid} was placed`,
      )
    },
  }
}

function cancelOrdersTool(clients: TradingToolClients): ChatTool<typeof CancelOrdersParameters> {
  return {
    definition: {
      name: "cancel_pending_viop_orders",
      description: "Cancel specific live pending VIOP orders. Use list_pending_orders first and pass only its order UIDs.",
      parameters: CancelOrdersParameters,
    },
    run: async ({ orderUids, reason }, options) => {
      const sources = clients.sources()
      const uniqueIds = [...new Set(orderUids)]
      const pending = await sources.orders.listPendingOrders({ signal: options.signal })
      const pendingIds = new Set(pending.map((order) => order.uid))
      const missing = uniqueIds.filter((id) => !pendingIds.has(id))
      if (missing.length > 0) throw new Error(`These orders are not pending: ${missing.join(", ")}`)
      await requireToolPermission(
        clients.permissions,
        options,
        "cancel_pending_viop_orders",
        `Cancel ${uniqueIds.length} pending VIOP order${uniqueIds.length === 1 ? "" : "s"}: ${uniqueIds.join(", ")}`,
        reason,
      )
      const result = await sources.orders.cancelPendingOrders({ orderUids: uniqueIds, signal: options.signal })
      return success(
        `Cancelled ${result.cancelledOrderUids.length} pending order${result.cancelledOrderUids.length === 1 ? "" : "s"}; ${result.failures.length} failed.`,
        result,
        `${result.cancelledOrderUids.length} pending VIOP order${result.cancelledOrderUids.length === 1 ? " was" : "s were"} cancelled`,
      )
    },
  }
}

function exitPositionTool(clients: TradingToolClients): ChatTool<typeof ExitPositionParameters> {
  return {
    definition: {
      name: "exit_viop_position",
      description: [
        "Close all or part of one live VIOP position with a marketable day limit order.",
        "The server rechecks the position before submission so an already-closed position cannot be reversed.",
      ].join(" "),
      parameters: ExitPositionParameters,
    },
    run: async ({ symbol, quantity, reason }, options) => {
      const sources = clients.sources()
      const instrument = resolveViopInstrument(
        await sources.instruments.listInstruments({ signal: options.signal }),
        symbol,
      )
      const account = await sources.account.loadAccount({ signal: options.signal })
      const position = account.positions.find((entry) => entry.uid === instrument.uid || entry.symbol === instrument.symbol)
      if (!position || position.quantity === 0) throw new Error(`There is no open position in ${instrument.symbol}`)
      const openQuantity = Math.abs(position.quantity)
      const exitQuantity = quantity ?? openQuantity
      if (exitQuantity > openQuantity) throw new Error(`Only ${openQuantity} contracts are open in ${instrument.symbol}`)
      const action = `Exit ${exitQuantity} of ${openQuantity} ${instrument.symbol} contract${openQuantity === 1 ? "" : "s"}`
      await requireToolPermission(clients.permissions, options, "exit_viop_position", action, reason)
      const submitted = await sources.orders.exitPosition({
        instrumentUid: instrument.uid,
        quantity: exitQuantity,
        signal: options.signal,
      })
      return success(
        `Submitted exit for ${submitted.quantity} ${submitted.symbol}. Order ${submitted.orderUid}.`,
        submitted,
        `Position exit order ${submitted.orderUid} was submitted`,
      )
    },
  }
}

function exitAllPositionsTool(clients: TradingToolClients): ChatTool<typeof ExitAllParameters> {
  return {
    definition: {
      name: "exit_all_viop_positions",
      description: "Close every live VIOP position with marketable day limit orders. This is a bulk live-trading action.",
      parameters: ExitAllParameters,
    },
    run: async ({ reason }, options) => {
      const sources = clients.sources()
      const account = await sources.account.loadAccount({ signal: options.signal })
      const positions = account.positions.filter((position) => position.quantity !== 0)
      if (positions.length === 0) throw new Error("There are no open VIOP positions")
      const summary = positions.map((position) => `${position.symbol} ${position.quantity}`).join(", ")
      await requireToolPermission(
        clients.permissions,
        options,
        "exit_all_viop_positions",
        `Exit all ${positions.length} VIOP positions: ${summary}`,
        reason,
      )
      const result = await sources.orders.exitAllPositions({ signal: options.signal })
      return success(
        `Submitted ${result.submitted.length} position exit${result.submitted.length === 1 ? "" : "s"}; ${result.failures.length} failed.`,
        result,
        `${result.submitted.length} position exit${result.submitted.length === 1 ? " was" : "s were"} submitted`,
      )
    },
  }
}

function success<TDetails>(text: string, details: TDetails, effect: string): ChatToolOutcome {
  return { blocks: [toolText(text)], details, isError: false, effects: [externalToolEffect(effect)] }
}
