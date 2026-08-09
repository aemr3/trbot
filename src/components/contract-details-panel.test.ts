import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ViopContractDetails, ViopInstrument } from "../market/instrument.ts"
import { ContractDetailsPanel } from "./contract-details-panel.ts"

const instrument: ViopInstrument = {
  uid: "future-1",
  symbol: "F_TUPRS0826",
  displayName: "TUPRS",
  underlyingSymbol: "TUPRS",
  lastPrice: 328.75,
  changePercent: -0.03,
  volume: 3_996_802_304,
  currency: "TRY",
}

const details: ViopContractDetails = {
  initialCollateral: 7_991.91,
  leverage: 4.11,
  contractSize: 100,
  expiryDate: "31/08/2026",
  sessionHigh: 338.15,
  sessionLow: 324.55,
  settlementPrice: 328.75,
  previousSettlementPrice: 328.85,
  volume: 3_996_802_304,
  openInterest: 170_108,
}

test("renders contract details, statistics, and one-contract costs", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 36, height: 14 })
  const panel = new ContractDetailsPanel(renderer)
  renderer.root.add(panel.root)

  panel.selectInstrument({ ...instrument }, true)
  panel.showDetails(instrument.uid, details)
  await renderOnce()
  const frame = captureCharFrame()

  expect(frame).toContain("Contract · TUPRS")
  expect(frame).toContain("Margin ₺7.991,91 · Lev 4,11")
  expect(frame).toContain("Size 100 · Exp 31/08/2026")
  expect(frame).toContain("Order size  ₺32.875,00")
  expect(frame).toContain("Required    ₺7.991,91")
  expect(frame).toContain("Stats · High ₺338,15 · Low ₺324,55")
  expect(frame).toContain("Vol 3.996.802.304 · OI 170.108")
  const lines = frame.split("\n")
  expect(lines.findIndex((line) => line.includes("1 contract")) - lines.findIndex((line) => line.includes("Size 100"))).toBe(2)
  expect(lines.findIndex((line) => line.includes("Stats ·")) - lines.findIndex((line) => line.includes("Required"))).toBe(2)

  renderer.destroy()
})

test("updates one-contract order size from a live price", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 36, height: 14 })
  const panel = new ContractDetailsPanel(renderer)
  renderer.root.add(panel.root)
  panel.selectInstrument({ ...instrument }, true)
  panel.showDetails(instrument.uid, details)

  panel.applyPrice(instrument.symbol, 330)
  await renderOnce()

  expect(captureCharFrame()).toContain("Order size  ₺33.000,00")
  renderer.destroy()
})
