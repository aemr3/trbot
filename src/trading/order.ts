export type ViopOrderSide = "BUY" | "SELL"
export const VIOP_ORDER_KINDS = ["LIMIT", "MARKETABLE_LIMIT"] as const
export type ViopOrderKind = (typeof VIOP_ORDER_KINDS)[number]
export type ViopPositionIntent = "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE"

export function isViopOrderKind(value: string): value is ViopOrderKind {
  return VIOP_ORDER_KINDS.some((kind) => kind === value)
}

export interface ViopOrderPreparation {
  lowerLimit: number | null
  upperLimit: number | null
  lastPrice: number | null
  ask: number | null
  bid: number | null
  priceScale: number
  contractSize: number | null
  initialCollateral: number | null
  availableCollateral: number | null
  currentPositionQuantity: number
  positionIntent: ViopPositionIntent
}

export interface PrepareViopOrderRequest {
  instrumentUid: string
  side: ViopOrderSide
  signal?: AbortSignal
}

export interface PlaceViopOrderRequest {
  instrumentUid: string
  side: ViopOrderSide
  quantity: number
  limitPrice: number
  signal?: AbortSignal
}

export interface PlacedViopOrder {
  uid: string
  status: string
  description: string | null
}

export interface ViopOrderSource {
  prepareOrder(request: PrepareViopOrderRequest): Promise<ViopOrderPreparation>
  placeOrder(request: PlaceViopOrderRequest): Promise<PlacedViopOrder>
}

export interface PendingViopOrder {
  uid: string
  title: string
  description: string | null
}

export interface CancelPendingViopOrdersRequest {
  orderUids: string[]
  signal?: AbortSignal
}

export interface ViopOrderCancellationFailure {
  orderUid: string
  message: string
}

export interface ViopOrderCancellationResult {
  cancelledOrderUids: string[]
  failures: ViopOrderCancellationFailure[]
}

export interface ViopOrderCancellationSource {
  listPendingOrders(options?: { signal?: AbortSignal }): Promise<PendingViopOrder[]>
  cancelPendingOrders(request: CancelPendingViopOrdersRequest): Promise<ViopOrderCancellationResult>
}

export interface SubmittedViopPositionExit {
  instrumentUid: string
  symbol: string
  quantity: number
  orderUid: string
}

export interface ViopPositionExitFailure {
  instrumentUid: string
  symbol: string
  quantity: number
  message: string
}

export interface ViopPositionExitResult {
  submitted: SubmittedViopPositionExit[]
  failures: ViopPositionExitFailure[]
}

export interface ExitViopPositionRequest {
  instrumentUid: string
  // Contracts to close; omitted exits whatever the position holds.
  quantity?: number
  signal?: AbortSignal
}

export interface ViopPositionExitSource {
  exitAllPositions(options?: { signal?: AbortSignal }): Promise<ViopPositionExitResult>
  // Closes one position. Unlike the bulk exit there is no failure list to
  // collect: a single target either submits or throws.
  exitPosition(request: ExitViopPositionRequest): Promise<SubmittedViopPositionExit>
}

export function resolveViopOrderPrice(
  kind: ViopOrderKind,
  side: ViopOrderSide,
  limitPrice: number | null,
  preparation: Pick<ViopOrderPreparation, "lowerLimit" | "upperLimit">,
): number | null {
  if (kind === "LIMIT") return positiveFinite(limitPrice)
  return positiveFinite(side === "BUY" ? preparation.upperLimit : preparation.lowerLimit)
}

export function viopOrderSize(price: number | null, quantity: number, contractSize: number | null): number | null {
  const resolvedPrice = positiveFinite(price)
  const resolvedContractSize = positiveFinite(contractSize)
  if (resolvedPrice === null || resolvedContractSize === null || !Number.isInteger(quantity) || quantity <= 0) return null
  return resolvedPrice * quantity * resolvedContractSize
}

export function viopRequiredCollateral(quantity: number, initialCollateral: number | null): number | null {
  const collateral = positiveFinite(initialCollateral)
  if (collateral === null || !Number.isInteger(quantity) || quantity <= 0) return null
  return collateral * quantity
}

export function viopAffordableContracts(
  availableCollateral: number | null,
  initialCollateral: number | null,
): number | null {
  const available = nonNegativeFinite(availableCollateral)
  const required = positiveFinite(initialCollateral)
  return available === null || required === null ? null : Math.floor(available / required)
}

export function viopRequiredOrderCollateral(
  quantity: number,
  initialCollateral: number | null,
  currentPositionQuantity: number,
  side: ViopOrderSide,
): number | null {
  const additionalContracts = viopAdditionalExposureContracts(quantity, currentPositionQuantity, side)
  if (additionalContracts === null) return null
  if (additionalContracts === 0) return 0
  return viopRequiredCollateral(additionalContracts, initialCollateral)
}

export function viopAffordableOrderContracts(
  availableCollateral: number | null,
  initialCollateral: number | null,
  currentPositionQuantity: number,
  side: ViopOrderSide,
): number | null {
  if (!Number.isInteger(currentPositionQuantity)) return null
  const openingCapacity = viopAffordableContracts(availableCollateral, initialCollateral)
  if (openingCapacity === null) return null
  const closesCurrentPosition = currentPositionQuantity !== 0
    && Math.sign(currentPositionQuantity) !== (side === "BUY" ? 1 : -1)
  return openingCapacity + (closesCurrentPosition ? 2 * Math.abs(currentPositionQuantity) : 0)
}

function viopAdditionalExposureContracts(
  quantity: number,
  currentPositionQuantity: number,
  side: ViopOrderSide,
): number | null {
  if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(currentPositionQuantity)) return null
  const positionAfterOrder = currentPositionQuantity + (side === "BUY" ? quantity : -quantity)
  return Math.max(0, Math.abs(positionAfterOrder) - Math.abs(currentPositionQuantity))
}

export function viopPositionIntent(positionQuantity: number, side: ViopOrderSide): ViopPositionIntent {
  if (positionQuantity > 0) return side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_CLOSE"
  if (positionQuantity < 0) return side === "BUY" ? "BUY_TO_CLOSE" : "SELL_TO_OPEN"
  return side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_OPEN"
}

function positiveFinite(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function nonNegativeFinite(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}
