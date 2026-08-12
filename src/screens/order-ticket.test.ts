import { expect, test } from "bun:test"
import { type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { PlaceViopOrderRequest, ViopOrderSource } from "../trading/order.ts"
import { ViopOrderTicket } from "./order-ticket.ts"

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

  ticket.handleKey({ name: "3", sequence: "3" } as KeyEvent)
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
  ticket.handleKey({ name: "l", sequence: "l" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Limit price"))
  ticket.handleKey({ name: "m", sequence: "m" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Resolved limit"))
  expect(kinds).toEqual(["LIMIT", "MARKETABLE_LIMIT"])

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses the exchange upper and lower limits for simulated market orders", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const placed: PlaceViopOrderRequest[] = []
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(placed),
    instrument,
    side: "SELL",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  const limitFrame = await setup.waitForFrame((value) => value.includes("₺188,30"))
  const limitPriceLine = limitFrame.split("\n").find((line) => line.includes("Limit price")) ?? ""

  ticket.handleKey({ name: "m", sequence: "m" } as KeyEvent)
  const marketFrame = await setup.waitForFrame((value) => value.includes("Simulated market") && value.includes("Resolved limit"))
  expect(marketFrame).toContain("₺188,30")
  const resolvedPriceLine = marketFrame.split("\n").find((line) => line.includes("Resolved limit")) ?? ""
  expect(resolvedPriceLine.indexOf("₺188,30")).toBe(limitPriceLine.indexOf("₺209,55"))
  ticket.handleKey({ name: "r", sequence: "r" } as KeyEvent)
  const reviewFrame = await setup.waitForFrame((value) => value.includes("Review sell order"))
  expect(reviewFrame).toContain("may remain as a day limit order")
  ticket.handleKey({ name: "return", sequence: "\r" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Order submitted"))

  expect(placed[0]).toMatchObject({ side: "SELL", quantity: 1, limitPrice: 188.3 })

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses the matching side key to review and submit the order", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const placed: PlaceViopOrderRequest[] = []
  const ticket = new ViopOrderTicket(setup.renderer, {
    source: fakeOrderSource(placed),
    instrument,
    side: "BUY",
    onClose() {},
  })
  setup.renderer.root.add(ticket.root)
  ticket.mount()
  await setup.waitForFrame((value) => value.includes("Upper limit"))

  ticket.handleKey({ name: "s", sequence: "s" } as KeyEvent)
  expect(placed).toHaveLength(0)
  ticket.handleKey({ name: "b", sequence: "b" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Review buy order"))
  ticket.handleKey({ name: "b", sequence: "b" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Order submitted"))
  expect(placed).toHaveLength(1)

  ticket.destroy()
  setup.renderer.destroy()
})

test("blocks review when available collateral is insufficient", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const source = fakeOrderSource()
  source.prepareOrder = async ({ side }) => ({
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

  ticket.handleKey({ name: "r", sequence: "r" } as KeyEvent)
  const frame = await setup.waitForFrame((value) => value.includes("Available collateral is insufficient"))
  expect(frame).not.toContain("Review buy order")

  ticket.destroy()
  setup.renderer.destroy()
})

test("uses only residual reversal exposure for the collateral check", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28 })
  const source = fakeOrderSource()
  source.prepareOrder = async () => ({
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

  ticket.handleKey({ name: "5", sequence: "5" } as KeyEvent)
  const reversalFrame = await setup.waitForFrame((value) => value.includes("₺104.775,00"))
  expect(reversalFrame.split("\n").find((line) => line.includes("Required collateral"))).toContain("₺4.719,55")
  ticket.handleKey({ name: "r", sequence: "r" } as KeyEvent)
  await setup.waitForFrame((value) => value.includes("Review sell order"))

  ticket.destroy()
  setup.renderer.destroy()
})

function fakeOrderSource(placed: PlaceViopOrderRequest[] = []): ViopOrderSource {
  return {
    async prepareOrder({ side }) {
      return {
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
