import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { PlaceViopOrderRequest, ViopOrderSource } from "@trbot/trading/order.ts"
import { ViopOrderTicket } from "./order-ticket.ts"
import { keyEvent } from "../key-event.test-fixture.ts"

const instrument = {
  uid: "future-1",
  symbol: "F_FTKFEN0826",
  displayName: "FTKFEN",
  underlyingSymbol: "FTKFEN",
  lastPrice: 209.55,
  changePercent: 0,
  volume: 1,
  currency: "TRY",
}

test("shows order limits and defaults a limit order to the last price", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(),
    instrument,
    side: "BUY",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()

  const frame = await setup.waitForFrame((value) => value.includes("Upper limit") && value.includes("₺230,10"))
  expect(frame).toContain("╭")
  expect(frame).toContain("╯")
  expect(frame).toContain("Buy FTKFEN 08/26")
  expect(frame).toContain("₺209,55")
  expect(frame).toContain("Order size")
  expect(frame).toContain("₺20.955,00")
  expect(frame).toContain("Required collateral")
  expect(frame).toContain("₺4.719,55")

  ticket.destroy()
  setup.renderer.destroy()
})

test("enters contract quantity immediately after the ticket opens", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(),
    instrument,
    side: "BUY",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  await setup.waitForFrame((value) => value.includes("Upper limit"))

  ticket.handleKey(keyEvent("3"))
  const frame = await setup.waitForFrame((value) => value.includes("₺62.865,00"))
  expect(frame).toContain("▸ 3")

  ticket.destroy()
  setup.renderer.destroy()
})

test("restores the preferred order type and reports M and L changes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const kinds: string[] = []
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(),
    instrument,
    side: "BUY",
    initialKind: "MARKETABLE_LIMIT",
    onKindChange: (kind) => kinds.push(kind),
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()

  await setup.waitForFrame((value) => value.includes("Simulated market"))
  ticket.handleKey(keyEvent("l"))
  await setup.waitForFrame((value) => value.includes("Limit price"))
  ticket.handleKey(keyEvent("m"))
  await setup.waitForFrame((value) => value.includes("Resolved limit"))
  expect(kinds).toEqual(["LIMIT", "MARKETABLE_LIMIT"])

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses the exchange upper and lower limits for simulated market orders", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const placed: PlaceViopOrderRequest[] = []
  let closeTicket!: () => void
  const closed = new Promise<void>((resolve) => {
    closeTicket = resolve
  })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(placed),
    instrument,
    side: "SELL",
    onClose: closeTicket,
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  const limitFrame = await setup.waitForFrame((value) => value.includes("₺188,30"))
  const limitPriceLine = limitFrame.split("\n").find((line) => line.includes("Limit price")) ?? ""

  ticket.handleKey(keyEvent("m"))
  const marketFrame = await setup.waitForFrame((value) => value.includes("Simulated market") && value.includes("Resolved limit"))
  expect(marketFrame).toContain("₺188,30")
  const resolvedPriceLine = marketFrame.split("\n").find((line) => line.includes("Resolved limit")) ?? ""
  expect(resolvedPriceLine.indexOf("₺188,30")).toBe(limitPriceLine.indexOf("₺209,55"))
  ticket.handleKey(keyEvent("r"))
  const reviewFrame = await setup.waitForFrame((value) => value.includes("Review sell order"))
  expect(reviewFrame).toContain("may remain as a day limit order")
  ticket.handleKey(keyEvent("return", { sequence: "\r" }))
  await closed

  expect(placed[0]).toMatchObject({ side: "SELL", quantity: 1, limitPrice: 188.3 })
  expect(setup.captureCharFrame()).not.toContain("Order submitted")

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses the matching side key to review and submit the order", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const placed: PlaceViopOrderRequest[] = []
  let closeTicket!: () => void
  const closed = new Promise<void>((resolve) => {
    closeTicket = resolve
  })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(placed),
    instrument,
    side: "BUY",
    onClose: closeTicket,
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  await setup.waitForFrame((value) => value.includes("Upper limit"))

  ticket.handleKey(keyEvent("s"))
  expect(placed).toHaveLength(0)
  ticket.handleKey(keyEvent("b"))
  await setup.waitForFrame((value) => value.includes("Review buy order"))
  ticket.handleKey(keyEvent("b"))
  await closed
  expect(placed).toHaveLength(1)

  ticket.destroy()
  setup.renderer.destroy()
})

test("blocks review when available collateral is insufficient", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const source = fakeOrderSource()
  source.prepareOrder = async ({ side }) => ({
    underlyingInstrumentUid: "underlying-1",
    lowerLimit: 188.3,
    upperLimit: 230.1,
    lastPrice: 209.55,
    ask: 210,
    bid: 209.55,
    priceScale: 2,
    contractSize: 100,
    initialCollateral: 4_719.55,
    availableCollateral: 0,
    currentPositionQuantity: 0,
    positionIntent: side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
  })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source,
    instrument,
    side: "BUY",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  await setup.waitForFrame((value) => value.includes("0 contracts available by collateral"))

  ticket.handleKey(keyEvent("r"))
  const frame = await setup.waitForFrame((value) => value.includes("Available collateral is insufficient"))
  expect(frame).not.toContain("Review buy order")

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses only residual reversal exposure for the collateral check", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const source = fakeOrderSource()
  source.prepareOrder = async () => ({
    underlyingInstrumentUid: "underlying-1",
    lowerLimit: 188.3,
    upperLimit: 230.1,
    lastPrice: 209.55,
    ask: 210,
    bid: 209.55,
    priceScale: 2,
    contractSize: 100,
    initialCollateral: 4_719.55,
    availableCollateral: 4_719.55,
    currentPositionQuantity: 2,
    positionIntent: "SELL_TO_CLOSE",
  })
  const ticket = new ViopOrderTicket(setup.renderer, {
    source,
    instrument,
    side: "SELL",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()

  const closeFrame = await setup.waitForFrame((value) => value.includes("5 contracts available by collateral"))
  expect(closeFrame.split("\n").find((line) => line.includes("Required collateral"))).toContain("₺0,00")

  ticket.handleKey(keyEvent("5"))
  const reversalFrame = await setup.waitForFrame((value) => value.includes("₺104.775,00"))
  expect(reversalFrame.split("\n").find((line) => line.includes("Required collateral"))).toContain("₺4.719,55")
  ticket.handleKey(keyEvent("r"))
  await setup.waitForFrame((value) => value.includes("Review sell order"))

  ticket.destroy()
  setup.renderer.destroy()
})

// A resubmit after a failure is the case idempotency keys exist for: the first
// attempt may have reached the exchange even though the answer never came back.
test("reuses one idempotency key across retries, and mints a new one once the order changes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const placed: PlaceViopOrderRequest[] = []
  const source = fakeOrderSource(placed)
  let failures = 2
  source.placeOrder = async (request) => {
    placed.push(request)
    if (failures > 0) {
      failures -= 1
      throw new Error("The connection dropped")
    }
    return { uid: "order-1", status: "PENDING", description: "Bekliyor" }
  }
  let closeTicket!: () => void
  const closed = new Promise<void>((resolve) => {
    closeTicket = resolve
  })
  const ticket = new ViopOrderTicket(setup.renderer, { source, instrument, side: "BUY", onClose: closeTicket })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  await setup.waitForFrame((value) => value.includes("Upper limit"))

  ticket.handleKey(keyEvent("r"))
  await setup.waitForFrame((value) => value.includes("Review buy order"))
  ticket.handleKey(keyEvent("return", { sequence: "\r" }))
  await setup.waitForFrame((value) => value.includes("The connection dropped"))

  // Same order, pressed again: the server must see the same key.
  ticket.handleKey(keyEvent("return", { sequence: "\r" }))
  await setup.waitForFrame((value) => value.includes("The connection dropped"))

  // A different size is a different order, however it is reached.
  ticket.handleKey(keyEvent("escape", { sequence: "" }))
  ticket.handleKey(keyEvent("3"))
  ticket.handleKey(keyEvent("r"))
  await setup.waitForFrame((value) => value.includes("Review buy order"))
  ticket.handleKey(keyEvent("return", { sequence: "\r" }))
  await closed

  expect(placed).toHaveLength(3)
  expect(placed[0]?.idempotencyKey).toBeTruthy()
  expect(placed[1]?.idempotencyKey).toBe(placed[0]?.idempotencyKey)
  expect(placed[2]?.quantity).toBe(3)
  expect(placed[2]?.idempotencyKey).not.toBe(placed[0]?.idempotencyKey)

  ticket.destroy()
  setup.renderer.destroy()
})

function fakeOrderSource(placed: PlaceViopOrderRequest[] = []): ViopOrderSource {
  return {
    async prepareOrder({ side }) {
      return {
        underlyingInstrumentUid: "underlying-1",
        lowerLimit: 188.3,
        upperLimit: 230.1,
        lastPrice: 209.55,
        ask: 210,
        bid: 209.55,
        priceScale: 2,
        contractSize: 100,
        initialCollateral: 4_719.55,
        availableCollateral: 50_000,
        currentPositionQuantity: 0,
        positionIntent: side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
      }
    },
    async placeOrder(request) {
      placed.push(request)
      return { uid: "order-1", status: "PENDING", description: "Bekliyor" }
    },
  }
}
