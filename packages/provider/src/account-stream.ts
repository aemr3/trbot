import type { ApiClient } from "@trbot/api"
import { isTransientStreamError } from "@trbot/api/transport.ts"
import type { AccountLiveUpdate, AccountLiveUpdateListener, AccountOrderStatus, AccountStream } from "@trbot/trading/account.ts"
import { z } from "zod"

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
const TRANSIENT_FAILURE_REPORT_THRESHOLD = 3

type AccountStreamApiClient = Pick<ApiClient, "authenticate" | "stream">
type PositionLiveUpdate = Extract<AccountLiveUpdate, { type: "position" }>
type CollateralLiveUpdate = Extract<AccountLiveUpdate, { type: "collateral" }>
type OrderLiveUpdate = Extract<AccountLiveUpdate, { type: "order" }>

export interface ApiAccountStreamOptions {
  onError?: (cause: unknown) => void
  onRecovery?: (channel: string, failures: number) => void
  reconnectDelaysMs?: number[]
}

export class ApiAccountStream implements AccountStream {
  private readonly listeners: AccountLiveUpdateListener[] = []
  private readonly connectionListeners: Array<(connected: boolean) => void> = []
  private readonly reconnectDelaysMs: number[]
  private readonly connectedChannels = new Set<string>()
  private readonly pendingOrderUids = new Set<string>()
  private readonly orderControllers = new Map<string, AbortController>()
  private readonly transientFailures = new Map<string, number>()
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
    this.transientFailures.clear()
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
          attempt = 0
          this.reportHealthy("positions")
          const updates = parseAccountPositionUpdates(frame.data)
          if (updates.length === 0) continue
          this.setChannelConnected("positions", true)
          for (const update of updates) this.emit(update)
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.reportFailure("positions", error)
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
          attempt = 0
          this.reportHealthy("overview")
          const update = parseAccountCollateralUpdate(frame.data)
          if (!update) continue
          this.setChannelConnected("overview", true)
          this.emit(update)
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.reportFailure("overview", error)
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
          attempt = 0
          this.reportHealthy(`order:${uid}`)
          const update = parseAccountOrderUpdate(frame.data, uid)
          if (!update) continue
          this.setChannelConnected(`order:${uid}`, true)
          this.emit(update)
          if (update.status === "completed") {
            this.pendingOrderUids.delete(uid)
            return
          }
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        this.reportFailure(`order:${uid}`, error)
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

  /** Reports a persistent transient outage once while preserving immediate errors. */
  private reportFailure(channel: string, cause: unknown): void {
    if (!isTransientStreamError(cause)) {
      this.transientFailures.delete(channel)
      this.options.onError?.(cause)
      return
    }

    const failures = (this.transientFailures.get(channel) ?? 0) + 1
    this.transientFailures.set(channel, failures)
    if (failures !== TRANSIENT_FAILURE_REPORT_THRESHOLD) return
    this.options.onError?.(new Error(
      `${channel} stream disconnected ${failures} consecutive times; retries continue`,
      { cause },
    ))
  }

  private reportHealthy(channel: string): void {
    const failures = this.transientFailures.get(channel)
    if (failures === undefined) return
    this.transientFailures.delete(channel)
    if (failures >= TRANSIENT_FAILURE_REPORT_THRESHOLD) this.options.onRecovery?.(channel, failures)
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
  const decoded = PositionFramesSchema.safeParse(parseJson(data))
  if (!decoded.success) return []
  return decoded.data.flatMap((entry): PositionLiveUpdate[] => {
    if (!entry.su || entry.q === null) return []
    return [{
      type: "position",
      uid: entry.su,
      quantity: entry.q,
      averageCost: entry.ac,
      country: entry.c,
    }]
  })
}

export function parseAccountCollateralUpdate(data: string): CollateralLiveUpdate | null {
  const decoded = parseJson(data)
  const availableCollateral = findNumericField(decoded, new Set(["availableCollateral", "usableCollateral"]))
  return availableCollateral === null ? null : { type: "collateral", availableCollateral }
}

export function parseAccountOrderUpdate(data: string, uid: string): OrderLiveUpdate | null {
  const parsed = OrderFrameSchema.safeParse(parseJson(data))
  if (!parsed.success) return null
  const entry = parsed.data
  const providerStatus = entry.status
  if (!providerStatus) return null
  return {
    type: "order",
    uid,
    status: orderStatus(providerStatus),
    providerStatus,
    description: entry.statusDescription,
  }
}

function orderStatus(providerStatus: string): AccountOrderStatus {
  return TERMINAL_ORDER_STATUSES.has(providerStatus.toUpperCase()) ? "completed" : "pending"
}

const JsonValueSchema = z.json()
type JsonValue = z.output<typeof JsonValueSchema>
const JsonArraySchema = z.array(JsonValueSchema)
const JsonObjectSchema = z.record(z.string(), JsonValueSchema)

const FiniteNumberSchema = z.union([z.number(), z.string()])
  .transform((value) => Number(value))
  .refine(Number.isFinite)
  .nullable()
  .catch(null)
const NonBlankStringSchema = z.string().trim().min(1).nullable().catch(null)

const PositionFramesSchema = z.array(z.object({
  su: NonBlankStringSchema,
  q: FiniteNumberSchema,
  ac: FiniteNumberSchema.optional().default(null),
  c: NonBlankStringSchema.optional().default(null),
}))

const OrderFrameSchema = z.object({
  status: NonBlankStringSchema,
  statusDescription: NonBlankStringSchema.optional().default(null),
})

function findNumericField(value: JsonValue | null, keys: Set<string>): number | null {
  const array = JsonArraySchema.safeParse(value)
  if (array.success) {
    for (const item of array.data) {
      const found = findNumericField(item, keys)
      if (found !== null) return found
    }
    return null
  }
  const object = JsonObjectSchema.safeParse(value)
  if (!object.success) return null
  const entry = object.data
  for (const key of keys) {
    const found = FiniteNumberSchema.parse(entry[key])
    if (found !== null) return found
  }
  for (const child of Object.values(entry)) {
    const found = findNumericField(child, keys)
    if (found !== null) return found
  }
  return null
}

function parseJson(data: string): JsonValue | null {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
