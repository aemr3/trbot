import type { ApiClient } from "@trbot/api"
import type { AccountLiveUpdate, AccountLiveUpdateListener, AccountOrderStatus, AccountStream } from "./account.ts"

const POSITION_STREAM_PATH = "/reactive-position-api/v2/stream/members"
const OVERVIEW_STREAM_PATH = "/reactive-portfolio-api/v1/stream/overview-sse"
const ORDER_STREAM_PATH = "/reactive-order-api/v1/stream/members"
const TERMINAL_ORDER_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETED",
  "EXPIRED",
  "FILLED",
  "PARTIALLY_CANCELED",
  "PARTIALLY_CANCELLED",
  "REJECTED",
])
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 3000, 5000]

type AccountStreamApiClient = Pick<ApiClient, "authenticate" | "stream">
type PositionLiveUpdate = Extract<AccountLiveUpdate, { type: "position" }>
type CollateralLiveUpdate = Extract<AccountLiveUpdate, { type: "collateral" }>
type OrderLiveUpdate = Extract<AccountLiveUpdate, { type: "order" }>

export interface ApiAccountStreamOptions {
  onError?: (error: unknown) => void
  reconnectDelaysMs?: number[]
}

export class ApiAccountStream implements AccountStream {
  private readonly listeners: AccountLiveUpdateListener[] = []
  private readonly connectionListeners: Array<(connected: boolean) => void> = []
  private readonly reconnectDelaysMs: number[]
  private readonly connectedChannels = new Set<string>()
  private readonly pendingOrderUids = new Set<string>()
  private readonly orderControllers = new Map<string, AbortController>()
  private controller: AbortController | null = null
  private running = false
  private connected = false

  constructor(
    private readonly client: AccountStreamApiClient,
    private readonly options: ApiAccountStreamOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  }

  subscribe(listener: AccountLiveUpdateListener): void {
    this.listeners.push(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener)
  }

  setPendingOrders(orderUids: string[]): void {
    const next = new Set(orderUids)
    for (const [uid, controller] of this.orderControllers) {
      if (next.has(uid)) continue
      controller.abort()
      this.orderControllers.delete(uid)
      this.setChannelConnected(`order:${uid}`, false)
    }
    this.pendingOrderUids.clear()
    for (const uid of next) {
      this.pendingOrderUids.add(uid)
      if (this.running) this.startOrderStream(uid)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    void this.runPositionStream(controller.signal)
    void this.runOverviewStream(controller.signal)
    for (const uid of this.pendingOrderUids) this.startOrderStream(uid)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.controller?.abort()
    this.controller = null
    for (const controller of this.orderControllers.values()) controller.abort()
    this.orderControllers.clear()
    this.connectedChannels.clear()
    this.notifyConnection(false)
  }

  private async runPositionStream(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (this.running && !signal.aborted) {
      try {
        const session = await this.client.authenticate()
        const path = `${POSITION_STREAM_PATH}/${encodeURIComponent(session.memberUid)}`
        for await (const frame of this.client.stream({ path, query: { eventTypes: "position" }, signal })) {
          if (!this.running || signal.aborted) return
          const updates = parseAccountPositionUpdates(frame.data)
          if (updates.length === 0) continue
          attempt = 0
          this.setChannelConnected("positions", true)
          for (const update of updates) this.emit(update)
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.options.onError?.(error)
      } finally {
        this.setChannelConnected("positions", false)
      }
      await pause(this.reconnectDelay(attempt++), signal)
    }
  }

  private async runOverviewStream(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (this.running && !signal.aborted) {
      try {
        for await (const frame of this.client.stream({ path: OVERVIEW_STREAM_PATH, signal })) {
          if (!this.running || signal.aborted) return
          const update = parseAccountCollateralUpdate(frame.data)
          if (!update) continue
          attempt = 0
          this.setChannelConnected("overview", true)
          this.emit(update)
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.options.onError?.(error)
      } finally {
        this.setChannelConnected("overview", false)
      }
      await pause(this.reconnectDelay(attempt++), signal)
    }
  }

  private startOrderStream(uid: string): void {
    if (this.orderControllers.has(uid)) return
    const controller = new AbortController()
    this.orderControllers.set(uid, controller)
    void this.runOrderStream(uid, controller.signal).finally(() => {
      if (this.orderControllers.get(uid) === controller) this.orderControllers.delete(uid)
      this.setChannelConnected(`order:${uid}`, false)
    })
  }

  private async runOrderStream(uid: string, signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (this.running && this.pendingOrderUids.has(uid) && !signal.aborted) {
      try {
        const session = await this.client.authenticate()
        const path = `${ORDER_STREAM_PATH}/${encodeURIComponent(session.memberUid)}/order/${encodeURIComponent(uid)}`
        for await (const frame of this.client.stream({ path, signal })) {
          if (!this.running || signal.aborted) return
          const update = parseAccountOrderUpdate(frame.data, uid)
          if (!update) continue
          attempt = 0
          this.setChannelConnected(`order:${uid}`, true)
          this.emit(update)
          if (update.status === "completed") {
            this.pendingOrderUids.delete(uid)
            return
          }
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.options.onError?.(error)
      } finally {
        this.setChannelConnected(`order:${uid}`, false)
      }
      await pause(this.reconnectDelay(attempt++), signal)
    }
  }

  private reconnectDelay(attempt: number): number {
    const index = Math.min(attempt, this.reconnectDelaysMs.length - 1)
    return this.reconnectDelaysMs[index] ?? 0
  }

  private emit(update: AccountLiveUpdate): void {
    for (const listener of this.listeners) listener(update)
  }

  private setChannelConnected(channel: string, connected: boolean): void {
    if (connected) this.connectedChannels.add(channel)
    else this.connectedChannels.delete(channel)
    this.notifyConnection(this.connectedChannels.size > 0)
  }

  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const listener of this.connectionListeners) listener(connected)
  }
}

export function parseAccountPositionUpdates(data: string): PositionLiveUpdate[] {
  const decoded = parseJson(data)
  if (!Array.isArray(decoded)) return []
  return decoded.flatMap((value): PositionLiveUpdate[] => {
    const entry = record(value)
    const uid = stringValue(entry.su)
    const quantity = finiteNumber(entry.q)
    if (!uid || quantity === null) return []
    return [{
      type: "position",
      uid,
      quantity,
      averageCost: finiteNumber(entry.ac),
      country: stringValue(entry.c),
    }]
  })
}

export function parseAccountCollateralUpdate(data: string): CollateralLiveUpdate | null {
  const decoded = parseJson(data)
  const availableCollateral = findNumericField(decoded, new Set(["availableCollateral", "usableCollateral"]))
  return availableCollateral === null ? null : { type: "collateral", availableCollateral }
}

export function parseAccountOrderUpdate(data: string, uid: string): OrderLiveUpdate | null {
  const entry = record(parseJson(data))
  const providerStatus = stringValue(entry.status)
  if (!providerStatus) return null
  return {
    type: "order",
    uid,
    status: orderStatus(providerStatus),
    providerStatus,
    description: stringValue(entry.statusDescription),
  }
}

function orderStatus(providerStatus: string): AccountOrderStatus {
  return TERMINAL_ORDER_STATUSES.has(providerStatus.toUpperCase()) ? "completed" : "pending"
}

function findNumericField(value: unknown, keys: Set<string>): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericField(item, keys)
      if (found !== null) return found
    }
    return null
  }
  const entry = record(value)
  for (const key of keys) {
    const found = finiteNumber(entry[key])
    if (found !== null) return found
  }
  for (const child of Object.values(entry)) {
    const found = findNumericField(child, keys)
    if (found !== null) return found
  }
  return null
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener("abort", done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
