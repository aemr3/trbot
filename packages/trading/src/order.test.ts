import { expect, test } from "bun:test"
import {
  resolveViopOrderPrice,
  viopAffordableContracts,
  viopAffordableOrderContracts,
  viopOrderSize,
  viopPositionIntent,
  viopRequiredCollateral,
  viopRequiredOrderCollateral,
} from "./order.ts"

test("resolves simulated market orders to the exchange price limits", () => {
  const preparation = { lowerLimit: 188.3, upperLimit: 230.1 }

  expect(resolveViopOrderPrice("MARKETABLE_LIMIT", "BUY", 210, preparation)).toBe(230.1)
  expect(resolveViopOrderPrice("MARKETABLE_LIMIT", "SELL", 209.55, preparation)).toBe(188.3)
  expect(resolveViopOrderPrice("LIMIT", "BUY", 210, preparation)).toBe(210)
})

test("calculates futures order size, collateral, and affordable contracts", () => {
  expect(viopOrderSize(210, 2, 100)).toBe(42_000)
  expect(viopRequiredCollateral(2, 4_719.55)).toBe(9_439.1)
  expect(viopAffordableContracts(10_000, 4_719.55)).toBe(2)
  expect(viopOrderSize(null, 1, 100)).toBeNull()
})

test("derives the provider position intent from the current futures position", () => {
  expect(viopPositionIntent(2, "BUY")).toBe("BUY_TO_OPEN")
  expect(viopPositionIntent(2, "SELL")).toBe("SELL_TO_CLOSE")
  expect(viopPositionIntent(-2, "BUY")).toBe("BUY_TO_CLOSE")
  expect(viopPositionIntent(-2, "SELL")).toBe("SELL_TO_OPEN")
  expect(viopPositionIntent(0, "SELL")).toBe("SELL_TO_OPEN")
})

test("charges collateral only for exposure left after closing an opposite position", () => {
  expect(viopRequiredOrderCollateral(2, 4_719.55, 2, "SELL")).toBe(0)
  expect(viopRequiredOrderCollateral(3, 4_719.55, 2, "SELL")).toBe(0)
  expect(viopRequiredOrderCollateral(5, 4_719.55, 2, "SELL")).toBe(4_719.55)
  expect(viopAffordableOrderContracts(0, 4_719.55, 2, "SELL")).toBe(4)
  expect(viopAffordableOrderContracts(4_719.55, 4_719.55, 2, "SELL")).toBe(5)
  expect(viopAffordableOrderContracts(4_719.55, 4_719.55, 2, "BUY")).toBe(1)
})
