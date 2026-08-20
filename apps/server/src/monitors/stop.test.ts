import { describe, expect, test } from "bun:test"
import type { QuoteUpdate } from "@trbot/market/quote-stream.ts"
import type { AccountPosition } from "@trbot/trading/account.ts"
import type {
  ExitViopPositionRequest,
  SubmittedViopPositionExit,
  ViopPositionExitResult,
  ViopPositionExitSource,
} from "@trbot/trading/order.ts"
import { createStopRule, type StopRule, type StopRuleDraft, type StopRuleStore } from "@trbot/trading/stop.ts"
import { StopController, type StopControllerEvent } from "./stop.ts"

const NOW = 1_786_000_000_000
const COUNTDOWN_MS = 40

class FakeStopRuleStore implements StopRuleStore {
  readonly rules = new Map<string, StopRule>()

  constructor(seed: StopRule[]) {
    for (const rule of seed) this.rules.set(rule.id, rule)
  }

  async list(): Promise<StopRule[]> {
    return [...this.rules.values()]
  }

  /** Set to make the next write fail, as a database under pressure would. */
  failNextPut = false

  async put(rule: StopRule): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error("the database is locked")
    }
    this.rules.set(rule.id, rule)
  }

  async remove(id: string): Promise<void> {
    this.rules.delete(id)
  }
}

class FakeExits implements ViopPositionExitSource {
  readonly exits: ExitViopPositionRequest[] = []
  failure: Error | null = null

  async exitAllPositions(): Promise<ViopPositionExitResult> {
    throw new Error("not used")
  }

  async exitPosition(request: ExitViopPositionRequest): Promise<SubmittedViopPositionExit> {
    this.exits.push(request)
    if (this.failure) throw this.failure
    return {
      orderUid: "order-1",
      instrumentUid: request.instrumentUid,
      symbol: "ASELS",
      quantity: request.quantity ?? 0,
    }
  }
}

function rule(): StopRule {
  const draft: StopRuleDraft = {
    id: "rule-1",
    instrumentUid: "instrument-1",
    symbol: "ASELS",
    displayName: "ASELS",
    side: "LONG",
    role: "STOP",
    kind: "PRICE",
    value: 380,
    basis: "TOUCH",
    interval: null,
    quantity: null,
    referencePrice: 400,
    atrValue: null,
  }
  return createStopRule(draft, NOW)
}

function position(): AccountPosition {
  return {
    uid: "instrument-1",
    symbol: "ASELS",
    displayName: "ASELS",
    quantity: 2,
    averageCost: 400,
    currentPrice: 400,
    unrealizedProfitLoss: null,
    currency: "TRY",
  }
}

function quote(price: number): QuoteUpdate {
  return { symbol: "ASELS", lastPrice: price, sessionStatus: null, timestamp: NOW }
}

async function controllerWith(countdownMs = COUNTDOWN_MS) {
  const store = new FakeStopRuleStore([rule()])
  const exits = new FakeExits()
  const events: StopControllerEvent[] = []
  const errors: unknown[] = []
  const controller = new StopController({
    store,
    exits: () => exits,
    broadcast: (event) => events.push(event),
    countdownMs,
    onError: (error) => errors.push(error),
    now: () => NOW,
  })
  await controller.rules.load()
  controller.setPositions([position()])
  // The first tick establishes that the level has not already passed.
  controller.applyQuote(quote(390))
  return { controller, exits, events, errors }
}

function trigger(controller: StopController): void {
  controller.applyQuote(quote(379))
}

describe("stop controller", () => {
  test("submits the exit when the countdown expires with nobody attached", async () => {
    const { controller, exits, events } = await controllerWith()
    trigger(controller)

    expect(events.some((event) => event.type === "triggered")).toBe(true)
    expect(exits.exits).toHaveLength(0)

    await Bun.sleep(COUNTDOWN_MS + 30)

    expect(exits.exits).toEqual([{ instrumentUid: "instrument-1", quantity: 2 }])
    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "SUBMITTED" })
    controller.destroy()
  })

  test("cancelling stands the stop down and sends nothing", async () => {
    const { controller, exits, events } = await controllerWith()
    trigger(controller)
    controller.decide("rule-1", "cancel")

    await Bun.sleep(COUNTDOWN_MS + 30)

    expect(exits.exits).toHaveLength(0)
    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "CANCELLED" })
    controller.destroy()
  })

  test("holding stops the clock until it is released", async () => {
    const { controller, exits } = await controllerWith()
    trigger(controller)
    controller.decide("rule-1", "hold")

    await Bun.sleep(COUNTDOWN_MS + 30)
    expect(exits.exits).toHaveLength(0)

    controller.decide("rule-1", "release")
    await Bun.sleep(COUNTDOWN_MS + 30)
    expect(exits.exits).toHaveLength(1)
    controller.destroy()
  })

  test("confirming sends the exit immediately", async () => {
    const { controller, exits } = await controllerWith(10_000)
    trigger(controller)
    controller.decide("rule-1", "confirm")
    await Bun.sleep(20)

    expect(exits.exits).toHaveLength(1)
    controller.destroy()
  })

  test("reports a failed exit rather than losing it silently", async () => {
    const { controller, exits, events, errors } = await controllerWith()
    exits.failure = new Error("provider rejected the exit")
    trigger(controller)

    await Bun.sleep(COUNTDOWN_MS + 30)

    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "FAILED" })
    expect(errors).toHaveLength(1)
    controller.destroy()
  })

  /**
   * A stop that fires while the session is being rebuilt is the position at its
   * most exposed. Giving up leaves the rule triggered with nothing behind it —
   * unprotected, and nothing on screen saying so — for a condition that clears
   * in seconds.
   */
  test("a trigger with no provider session waits for one rather than giving up", async () => {
    const store = new FakeStopRuleStore([rule()])
    const events: StopControllerEvent[] = []
    const provider = new FakeExits()
    let session: ViopPositionExitSource | null = null
    const controller = new StopController({
      store,
      exits: () => session,
      broadcast: (event) => events.push(event),
      countdownMs: COUNTDOWN_MS,
      submitRetryMs: 10,
      maxSubmitAttempts: 20,
      now: () => NOW,
    })
    await controller.rules.load()
    controller.setPositions([position()])
    controller.applyQuote(quote(390))
    controller.applyQuote(quote(379))

    await Bun.sleep(COUNTDOWN_MS + 40)
    // Still waiting: nothing resolved, and the countdown is not quietly over.
    expect(events.filter((event) => event.type === "resolved")).toBeEmpty()

    // Recovery finishes and the exit goes out, which is the whole point.
    session = provider
    await Bun.sleep(40)

    expect(provider.exits).toHaveLength(1)
    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "SUBMITTED" })
    controller.destroy()
  })

  test("a session that never comes back reports the exit as failed", async () => {
    const store = new FakeStopRuleStore([rule()])
    const events: StopControllerEvent[] = []
    const errors: unknown[] = []
    const controller = new StopController({
      store,
      exits: () => null,
      broadcast: (event) => events.push(event),
      countdownMs: COUNTDOWN_MS,
      submitRetryMs: 5,
      maxSubmitAttempts: 2,
      onError: (error) => errors.push(error),
      now: () => NOW,
    })
    await controller.rules.load()
    controller.setPositions([position()])
    controller.applyQuote(quote(390))
    controller.applyQuote(quote(379))

    await Bun.sleep(COUNTDOWN_MS + 60)

    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "FAILED" })
    expect(errors).toHaveLength(1)
    // Stood down rather than left triggered, so it neither fires again nor sits
    // there reading as a protected position.
    expect(controller.rules.rule("rule-1")?.status).toBe("PAUSED")
    controller.destroy()
  })

  /**
   * A dropped response is not a refusal. The exit may be at the provider, and
   * "failed" would tell the trader their position is still open.
   */
  test("an exit whose outcome was never learned is reported as unknown", async () => {
    const store = new FakeStopRuleStore([rule()])
    const events: StopControllerEvent[] = []
    const controller = new StopController({
      store,
      exits: () => ({
        async exitAllPositions() {
          throw new Error("bulk exits are not used by this controller")
        },
        async exitPosition() {
          throw new Error("The socket connection was closed unexpectedly")
        },
      } satisfies ViopPositionExitSource),
      isDefiniteRefusal: () => false,
      broadcast: (event) => events.push(event),
      countdownMs: COUNTDOWN_MS,
      onError: () => {},
      now: () => NOW,
    })
    await controller.rules.load()
    controller.setPositions([position()])
    controller.applyQuote(quote(390))
    controller.applyQuote(quote(379))

    await Bun.sleep(COUNTDOWN_MS + 40)

    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "UNKNOWN" })
    expect(controller.rules.rule("rule-1")?.status).toBe("PAUSED")
    controller.destroy()
  })

  /**
   * The exit reached the provider; only writing it down failed. Reporting that
   * as a failed exit is the one answer that is actively wrong.
   */
  test("an exit that was sent is reported as sent even when recording it fails", async () => {
    const store = new FakeStopRuleStore([rule()])
    const events: StopControllerEvent[] = []
    const errors: unknown[] = []
    const provider = new FakeExits()
    const controller = new StopController({
      store,
      exits: () => provider,
      broadcast: (event) => events.push(event),
      countdownMs: COUNTDOWN_MS,
      onError: (error) => errors.push(error),
      now: () => NOW,
    })
    await controller.rules.load()
    controller.setPositions([position()])
    controller.applyQuote(quote(390))
    controller.applyQuote(quote(379))
    store.failNextPut = true

    await Bun.sleep(COUNTDOWN_MS + 40)

    expect(provider.exits).toHaveLength(1)
    expect(events).toContainEqual({ type: "resolved", ruleId: "rule-1", outcome: "SUBMITTED" })
    expect(errors).toHaveLength(1)
    controller.destroy()
  })

  test("a client connecting mid-countdown sees what is outstanding", async () => {
    const { controller } = await controllerWith(10_000)
    trigger(controller)

    const outstanding = controller.outstanding()
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]).toMatchObject({ type: "triggered", held: false })
    controller.destroy()
  })
})
