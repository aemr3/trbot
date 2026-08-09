import type { ApiClient } from "../api/index.ts"
import { accountOperations, type AccountOverviewData, type AccountPositionsData } from "../api/account.ts"
import { tradingOperations, type OrderPreparationData } from "../api/trading.ts"
import {
  viopPositionIntent,
  type PlaceViopOrderRequest,
  type PlacedViopOrder,
  type PrepareViopOrderRequest,
  type ViopOrderPreparation,
  type ViopOrderSource,
  type ViopPositionIntent,
} from "./order.ts"

type OrderApiClient = Pick<ApiClient, "authenticate" | "call">

interface PreparedOrderContext {
  accountUid: string
  positionIntent: ViopPositionIntent
  preparation: NonNullable<OrderPreparationData["orderPreparationV2"]>
  result: ViopOrderPreparation
}

export class ApiViopOrderSource implements ViopOrderSource {
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
    const scale = 10 ** priceScale
    if (Math.abs(Math.round(request.limitPrice * scale) / scale - request.limitPrice) > Number.EPSILON) {
      throw new Error(`Limit price supports at most ${priceScale} decimal places`)
    }

    const data = await this.client.call(
      tradingOperations.placeOrder,
      {
        instrumentId: request.instrumentUid,
        accountId: context.accountUid,
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
        positionIntent: context.positionIntent,
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
