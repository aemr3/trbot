import { expect, test } from "bun:test"
import type { AccountLiveUpdate, AccountSnapshot, AccountStream } from "@trbot/trading/account.ts"
import type { StopRule, StopRuleStore } from "@trbot/trading/stop.ts"
import { StopController } from "./monitors/stop.ts"
import { ProviderSession, type ProviderSources } from "./session.ts"
import { StreamHub } from "./stream-hub.ts"

/**
 * The chain a closing position travels: a frame arrives, the server re-reads the
 * account, and the stop monitor's idea of what is held changes.
 *
 * A stop decides both whether to fire and how much to exit from that idea, so a
 * stale one can send an exit for a position that is already gone. This wires the
 * same pieces the server does in `index.ts`.
 */
test("a position closing on the stream reaches the stop monitor", async () => {
  const rules = new Map<string, StopRule>()
  const store: StopRuleStore = {
    async list() {
      return [...rules.values()]
    },
    async put(rule) {
      rules.set(rule.id, rule)
    },
    async remove(id) {
      rules.delete(id)
    },
  }

  let held = 5
  const account = {
    async loadAccount(): Promise<AccountSnapshot> {
      return {
        positions: held > 0
          ? [{ uid: "future-1", symbol: "F_XU0300826", quantity: held } as never]
          : [],
      } as unknown as AccountSnapshot
    },
  }

  const listeners: ((update: AccountLiveUpdate) => void)[] = []
  const accountStream = {
    subscribe(next: (update: AccountLiveUpdate) => void) {
      listeners.push(next)
    },
    onConnectionChange() {},
    start() {},
    stop() {},
    setPendingOrders() {},
  }

  const stops = new StopController({ store, exits: () => null, broadcast: () => {} })
  await stops.save({
    instrumentUid: "future-1",
    symbol: "F_XU0300826",
    displayName: "XU030 08/26",
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 305,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 310,
    atrValue: null,
  })

  const sources = {
    quotes: { subscribe() {}, onConnectionChange() {}, start() {}, stop() {} },
    accountStream: accountStream as unknown as AccountStream,
    account,
    openDepthStream: () => ({ subscribe() {}, onStatusChange() {}, start() {}, stop() {} }),
    openEquityQuoteStream: () => ({ subscribe() {}, onConnectionChange() {}, start() {}, stop() {} }),
  } as unknown as ProviderSources

  const session = new ProviderSession({
    openAuthSession: async () => ({
      store: { async get() { return null }, async latest() { return null }, async put() {} },
      close() {},
    }),
    credentials: null,
  })
  ;(session as unknown as { current: ProviderSources }).current = sources

  const refresh = async (): Promise<void> => {
    stops.setPositions((await session.require().account.loadAccount()).positions)
  }
  const hub = new StreamHub(session, {
    wantsAccount: () => true,
    onAccount: (update) => {
      if (update.type === "position") void refresh()
    },
  })
  hub.refresh()
  await refresh()

  expect(stops.rules.views()[0]?.hasPosition).toBe(true)

  // The trader closes the position elsewhere.
  held = 0
  const closed = { type: "position", uid: "future-1", quantity: 0, averageCost: null, country: null } as const
  for (const notify of listeners) notify(closed)
  await Bun.sleep(10)

  expect(stops.rules.views()[0]?.hasPosition ?? false).toBe(false)
  stops.destroy()
})
