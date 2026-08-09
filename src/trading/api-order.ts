import type { ApiClient } from "../api/index.ts"
import {
  accountOperations,
  type AccountOrderEntry,
  type AccountOverviewData,
  type AccountPositionsData,
} from "../api/account.ts"
import { tradingOperations, type OrderPreparationData } from "../api/trading.ts"
import {
  viopPositionIntent,
  type PlaceViopOrderRequest,
  type PlacedViopOrder,
  type PendingViopOrder,
  type PrepareViopOrderRequest,
  type ViopOrderCancellationResult,
  type ViopOrderCancellationSource,
  type ViopOrderPreparation,
  type ViopOrderSource,
  type ViopPositionExitResult,
  type ViopPositionExitSource,
  type ViopPositionIntent,
} from "./order.ts"

type OrderApiClient = Pick<ApiClient, "authenticate" | "call">

const ASSET_VERTICAL = "TR"
const INVESTMENT_TYPE = "FUTURES"
const ORDER_PAGE_SIZE = 20

interface PreparedOrderContext {
  accountUid: string
  positionIntent: ViopPositionIntent
  preparation: NonNullable<OrderPreparationData["orderPreparationV2"]>
  result: ViopOrderPreparation
}

export class ApiViopOrderSource implements ViopOrderSource, ViopOrderCancellationSource, ViopPositionExitSource {
  constructor(private readonly client: OrderApiClient) {}

  async prepareOrder(request: PrepareViopOrderRequest): Promise<ViopOrderPreparation> {
    return (await this.prepareContext(request)).result
  }

  async placeOrder(request: PlaceViopOrderRequest): Promise<PlacedViopOrder> {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error("Contract quantity must be a positive integer")
    }
    if (!Number.isFinite(request.limitPrice) || request.limitPrice <= 0) {
      throw new Error("Limit price must be greater than zero")
    }

    const context = await this.prepareContext(request)
    const { lowerLimit, upperLimit, priceScale } = context.result
    if (lowerLimit !== null && request.limitPrice < lowerLimit) throw new Error("Limit price is below the exchange lower limit")
    if (upperLimit !== null && request.limitPrice > upperLimit) throw new Error("Limit price is above the exchange upper limit")
    assertPriceScale(request.limitPrice, priceScale)

    return this.submitLimitOrder({
      accountUid: context.accountUid,
      instrumentUid: request.instrumentUid,
      quantity: request.quantity,
      limitPrice: request.limitPrice,
      side: request.side,
      positionIntent: context.positionIntent,
      signal: request.signal,
    })
  }

  async exitAllPositions(options: { signal?: AbortSignal } = {}): Promise<ViopPositionExitResult> {
    const session = await this.client.authenticate()
    const [overview, positionsData] = await Promise.all([
      this.client.call(
        accountOperations.overview,
        { memberId: session.memberUid, currencyCode: "TRY", period: "DAY" },
        options,
      ),
      this.client.call(accountOperations.positions, { accountId: session.memberUid }, options),
    ])
    const accountUid = activeTryAccountUid(overview)
    const positions = openPositions(positionsData)
    const result: ViopPositionExitResult = { submitted: [], failures: [] }

    for (const position of positions) {
      const quantity = Math.abs(position.quantity)
      if (!Number.isInteger(quantity)) {
        result.failures.push({ ...position, quantity, message: "Position quantity must be a whole number of contracts" })
        continue
      }
      const side = position.quantity > 0 ? "SELL" : "BUY"
      const positionIntent = position.quantity > 0 ? "SELL_TO_CLOSE" : "BUY_TO_CLOSE"
      try {
        const [future, prepared] = await Promise.all([
          this.client.call(
            tradingOperations.assetFuture,
            { instrumentId: position.instrumentUid, memberId: session.memberUid },
            options,
          ),
          this.client.call(
            tradingOperations.prepareOrder,
            {
              orderId: null,
              instrumentId: position.instrumentUid,
              accountId: accountUid,
              orderSide: side,
              orderType: "LIMIT",
              positionIntent,
            },
            options,
          ),
        ])
        const preparation = prepared.orderPreparationV2
        if (!preparation) throw new Error("Order preparation is unavailable")
        assertPreparationAllowsLimitOrder(preparation)
        const limitPrice = finiteNumber(side === "BUY" ? preparation.priceRange?.maxPrice : preparation.priceRange?.minPrice)
        if (limitPrice === null || limitPrice <= 0) throw new Error("Exchange price limit is unavailable")
        assertPriceScale(limitPrice, boundedScale(future.assetFuture?.priceFormat?.scale))
        const order = await this.submitLimitOrder({
          accountUid,
          instrumentUid: position.instrumentUid,
          quantity,
          limitPrice,
          side,
          positionIntent,
          signal: options.signal,
        })
        result.submitted.push({ ...position, quantity, orderUid: order.uid })
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) throw error
        result.failures.push({ ...position, quantity, message: errorMessage(error) })
      }
    }
    return result
  }

  private async submitLimitOrder(request: {
    accountUid: string
    instrumentUid: string
    quantity: number
    limitPrice: number
    side: "BUY" | "SELL"
    positionIntent: ViopPositionIntent
    signal?: AbortSignal
  }): Promise<PlacedViopOrder> {
    const data = await this.client.call(
      tradingOperations.placeOrder,
      {
        instrumentId: request.instrumentUid,
        accountId: request.accountUid,
        quantity: request.quantity,
        notional: null,
        price: null,
        stopPrice: null,
        limitPrice: request.limitPrice,
        profitPrice: null,
        profitRate: null,
        lossPrice: null,
        lossRate: null,
        isProfitByRatio: null,
        isLossByRatio: null,
        timeInForce: "DAY",
        orderSide: request.side,
        orderType: "LIMIT",
        agreementType: null,
        shouldPlaceInExtendedHours: false,
        endingDate: null,
        investmentType: "FUTURES",
        positionIntent: request.positionIntent,
      },
      { signal: request.signal },
    )
    const order = data.placeOrderV2?.order
    if (!order?.uid) throw new Error(orderErrorMessage(data) ?? "Order submission returned no order ID")
    return {
      uid: order.uid,
      status: order.status ?? "PENDING",
      description: order.statusDescription ?? null,
    }
  }

  async listPendingOrders(options: { signal?: AbortSignal } = {}): Promise<PendingViopOrder[]> {
    const session = await this.client.authenticate()
    const orders: PendingViopOrder[] = []
    const seen = new Set<string>()
    for (let page = 0; ; page += 1) {
      const data = await this.client.call(
        accountOperations.orders,
        {
          memberId: session.memberUid,
          status: "PENDING",
          page,
          size: ORDER_PAGE_SIZE,
          assetVertical: ASSET_VERTICAL,
          investmentType: INVESTMENT_TYPE,
        },
        options,
      )
      const result = data.transactionHistoryForInvestmentType
      if (result?.error) throw new Error(providerOrderListError(result.error))
      const entries = result?.items ?? []
      for (const order of entries.flatMap(normalizePendingOrder)) {
        if (seen.has(order.uid)) continue
        seen.add(order.uid)
        orders.push(order)
      }
      if (!result?.hasMore) return orders
      if (entries.length === 0) throw new Error("Pending-order pagination returned an empty page")
    }
  }

  async cancelPendingOrders(request: { orderUids: string[]; signal?: AbortSignal }): Promise<ViopOrderCancellationResult> {
    const orderUids = [...new Set(request.orderUids.filter(Boolean))]
    if (orderUids.length === 0) return { cancelledOrderUids: [], failures: [] }
    const session = await this.client.authenticate()
    const overview = await this.client.call(
      accountOperations.overview,
      { memberId: session.memberUid, currencyCode: "TRY", period: "DAY" },
      { signal: request.signal },
    )
    const accountUid = activeTryAccountUid(overview)
    const result: ViopOrderCancellationResult = { cancelledOrderUids: [], failures: [] }
    for (const orderUid of orderUids) {
      try {
        const data = await this.client.call(
          tradingOperations.cancelOrder,
          { accountId: accountUid, orderId: orderUid, instrumentId: null },
          { signal: request.signal },
        )
        const cancelledOrderUid = data.cancelOrder?.order?.uid
        if (!cancelledOrderUid) throw new Error("Cancellation returned no order ID")
        if (cancelledOrderUid !== orderUid) throw new Error("Cancellation returned a different order ID")
        result.cancelledOrderUids.push(orderUid)
      } catch (error) {
        if (request.signal?.aborted || isAbortError(error)) throw error
        result.failures.push({ orderUid, message: errorMessage(error) })
      }
    }
    return result
  }

  private async prepareContext(request: PrepareViopOrderRequest): Promise<PreparedOrderContext> {
    if (!request.instrumentUid) throw new Error("Instrument ID is required")
    const session = await this.client.authenticate()
    const [overview, positions, future] = await Promise.all([
      this.client.call(
        accountOperations.overview,
        { memberId: session.memberUid, currencyCode: "TRY", period: "DAY" },
        { signal: request.signal },
      ),
      this.client.call(
        accountOperations.positions,
        { accountId: session.memberUid },
        { signal: request.signal },
      ),
      this.client.call(
        tradingOperations.assetFuture,
        { instrumentId: request.instrumentUid, memberId: session.memberUid },
        { signal: request.signal },
      ),
    ])
    const accountUid = activeTryAccountUid(overview)
    const positionQuantity = currentPositionQuantity(positions, request.instrumentUid)
    const positionIntent = viopPositionIntent(positionQuantity, request.side)
    const [prepared, margin] = await Promise.all([
      this.client.call(
        tradingOperations.prepareOrder,
        {
          orderId: null,
          instrumentId: request.instrumentUid,
          accountId: accountUid,
          orderSide: request.side,
          orderType: "LIMIT",
          positionIntent,
        },
        { signal: request.signal },
      ),
      this.client.call(
        accountOperations.margin,
        { accountId: accountUid },
        { signal: request.signal },
      ),
    ])
    const preparation = prepared.orderPreparationV2
    if (!preparation) throw new Error("Order preparation is unavailable")
    assertPreparationAllowsLimitOrder(preparation)

    const asset = future.assetFuture
    const quote = asset?.tradePriceAndQuote
    const priceScale = boundedScale(asset?.priceFormat?.scale)
    return {
      accountUid,
      positionIntent,
      preparation,
      result: {
        lowerLimit: finiteNumber(preparation.priceRange?.minPrice),
        upperLimit: finiteNumber(preparation.priceRange?.maxPrice),
        lastPrice: finiteNumber(quote?.futurePrice),
        ask: finiteNumber(quote?.ask),
        bid: finiteNumber(quote?.bid),
        priceScale,
        contractSize: finiteNumber(asset?.multiplier),
        initialCollateral: finiteNumber(preparation.initialCollateral),
        availableCollateral: finiteNumber(margin.accountViopMarginHealthDetail?.availableCollateral),
        positionIntent,
      },
    }
  }
}

function normalizePendingOrder(entry: AccountOrderEntry): PendingViopOrder[] {
  if (!entry.uid) return []
  const detail = entry.detail
  return [{
    uid: entry.uid,
    title: detail?.title ?? entry.typeV2 ?? "VIOP order",
    description: detail?.titleDescription?.description ?? detail?.titleDescription?.subDescription?.text ?? null,
  }]
}

function activeTryAccountUid(data: AccountOverviewData): string {
  const account = data.overviewV7?.accounts?.find(
    (candidate) => candidate.status === "ACTIVE" && candidate.currency === "TRY" && candidate.accountUid,
  )
  if (!account?.accountUid) throw new Error("No active TRY investment account was found")
  return account.accountUid
}

function currentPositionQuantity(data: AccountPositionsData, instrumentUid: string): number {
  const entry = data.viopOverviewPositions?.positions?.find((position) => position.assetUid === instrumentUid)
  return finiteNumber(entry?.quantity) ?? 0
}

function openPositions(data: AccountPositionsData): Array<{ instrumentUid: string; symbol: string; quantity: number }> {
  const positions = new Map<string, { instrumentUid: string; symbol: string; quantity: number }>()
  for (const entry of data.viopOverviewPositions?.positions ?? []) {
    const instrumentUid = entry.assetUid
    const quantity = finiteNumber(entry.quantity)
    if (!instrumentUid || quantity === null || quantity === 0) continue
    const existing = positions.get(instrumentUid)
    if (existing) existing.quantity += quantity
    else positions.set(instrumentUid, { instrumentUid, symbol: entry.symbol ?? entry.displayName ?? instrumentUid, quantity })
  }
  return [...positions.values()].filter((position) => position.quantity !== 0)
}

function assertPriceScale(price: number, priceScale: number): void {
  const scale = 10 ** priceScale
  if (Math.abs(Math.round(price * scale) / scale - price) > Number.EPSILON) {
    throw new Error(`Limit price supports at most ${priceScale} decimal places`)
  }
}

function assertPreparationAllowsLimitOrder(preparation: NonNullable<OrderPreparationData["orderPreparationV2"]>): void {
  if (preparation.type && preparation.type !== "LIMIT") throw new Error("Provider prepared a different order type")
  if (preparation.availableOrderTypes?.length && !preparation.availableOrderTypes.includes("LIMIT")) {
    throw new Error("Limit orders are unavailable for this contract")
  }
  const validity = preparation.validityPeriodDto?.tradingRangeDto?.validityPeriodCalendarItems
  if (validity?.length && !validity.some((item) => item.isActive && item.timeInForce === "DAY")) {
    throw new Error("Day orders are currently unavailable")
  }
  if (preparation.agreementType) throw new Error("This order requires an agreement in the provider app")
  if (preparation.warning) throw new Error(preparation.warning.body ?? preparation.warning.title ?? "Provider blocked this order")
  if (preparation.popup) throw new Error(preparation.popup.body ?? preparation.popup.title ?? "Provider blocked this order")
}

function orderErrorMessage(data: { placeOrderV2?: { orderSuccess?: { messageCard?: { messageCard?: { title?: string | null; description?: string | null } | null } | null } | null } | null }): string | null {
  const message = data.placeOrderV2?.orderSuccess?.messageCard?.messageCard
  return message?.description ?? message?.title ?? null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function boundedScale(value: unknown): number {
  const parsed = finiteNumber(value)
  return parsed === null ? 2 : Math.max(0, Math.min(8, Math.floor(parsed)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerOrderListError(error: unknown): string {
  if (typeof error === "string" && error) return error
  return "Provider could not list pending VIOP orders"
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
