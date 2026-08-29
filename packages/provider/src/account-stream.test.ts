import { expect, test } from "bun:test"
import type { SseFrame } from "@trbot/api/transport.ts"
import type { AccountLiveUpdate } from "@trbot/trading/account.ts"
import {
  ApiAccountStream,
  parseAccountCollateralUpdate,
  parseAccountOrderUpdate,
  parseAccountPositionUpdates,
} from "./account-stream.ts"

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("decodes compact positions, nested collateral, and order results", () => {
  expect(parseAccountPositionUpdates('[{"su":"future-1","q":"2","ac":300,"c":"TR"}]')).toEqual([{
    type: "position",
    uid: "future-1",
    quantity: 2,
    averageCost: 300,
    country: "TR",
  }])
  expect(parseAccountCollateralUpdate('{"type":"CollateralInfo","data":{"usableCollateral":47000}}')).toEqual({
    type: "collateral",
    availableCollateral: 47_000,
  })
  expect(parseAccountOrderUpdate('{"status":"FILLED","statusDescription":"Gerçekleşti"}', "order-1")).toEqual({
    type: "order",
    uid: "order-1",
    status: "completed",
    providerStatus: "FILLED",
    description: "Gerçekleşti",
  })
  expect(parseAccountPositionUpdates("heartbeat")).toEqual([])
  expect(parseAccountCollateralUpdate("{}")).toBeNull()
})

test("streams positions, collateral, and pending order status with the captured routes", async () => {
  const calls: Array<{ path: string; query?: Record<string, string> }> = []
  const frames = new Map<string, SseFrame>([
    ["position", { event: "Position", data: '[{"su":"future-1","q":3,"ac":305,"c":"TR"}]' }],
    ["overview", { event: "Overview", data: '{"collateralInfo":{"availableCollateral":48000}}' }],
    ["order", { event: "OrderResult", data: '{"status":"COMPLETED"}' }],
  ])
  const client = {
    async getMemberUid() {
      return "member 1"
    },
    async *stream(options: { path: string; query?: Record<string, string>; signal?: AbortSignal }): AsyncGenerator<SseFrame> {
      calls.push({ path: options.path, query: options.query })
      const key = options.path.includes("reactive-position")
        ? "position"
        : options.path.includes("overview-sse")
          ? "overview"
          : "order"
      const frame = frames.get(key)
      if (frame) yield frame
    },
  }
  const updates: AccountLiveUpdate[] = []
  const connections: boolean[] = []
  const stream = new ApiAccountStream(client, { reconnectDelaysMs: [1000] })
  stream.subscribe((update) => updates.push(update))
  stream.onConnectionChange((connected) => connections.push(connected))
  stream.setPendingOrders(["order/1"])
  stream.start()

  await waitFor(() => updates.length === 3)
  stream.stop()

  expect(calls).toContainEqual({
    path: "/reactive-position-api/v2/stream/members/member%201",
    query: { eventTypes: "position" },
  })
  expect(calls.map((call) => call.path)).toContain("/reactive-portfolio-api/v1/stream/overview-sse")
  expect(calls.map((call) => call.path)).toContain(
    "/reactive-order-api/v1/stream/members/member%201/order/order%2F1",
  )
  expect(updates.map((update) => update.type).sort()).toEqual(["collateral", "order", "position"])
  expect(connections).toContain(true)
  expect(connections.at(-1)).toBe(false)
})

test("reports a sustained transient outage once and logs its recovery", async () => {
  let positionAttempts = 0
  const client = {
    async getMemberUid() {
      return "member-1"
    },
    async *stream(options: { path: string; signal?: AbortSignal }): AsyncGenerator<SseFrame> {
      if (options.path.includes("overview-sse")) {
        await waitForAbort(options.signal)
        return
      }
      positionAttempts += 1
      if (positionAttempts <= 5) {
        throw new Error("The socket connection was closed unexpectedly")
      }
      yield { event: "Position", data: '[{"su":"future-1","q":1}]' }
      await waitForAbort(options.signal)
    },
  }
  const errors: unknown[] = []
  const recoveries: Array<{ channel: string; failures: number }> = []
  const stream = new ApiAccountStream(client, {
    reconnectDelaysMs: [0],
    onError: (error) => errors.push(error),
    onRecovery: (channel, failures) => recoveries.push({ channel, failures }),
  })
  stream.start()

  await waitFor(() => recoveries.length === 1)
  stream.stop()

  expect(errors).toHaveLength(1)
  const reported = errors[0]
  expect(reported).toBeInstanceOf(Error)
  if (!(reported instanceof Error)) throw new Error("Expected the outage report to be an Error")
  expect(reported.message).toContain("disconnected 3 consecutive times")
  expect(recoveries).toEqual([{ channel: "positions", failures: 5 }])
})

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}
