import { expect, test } from "bun:test"
import { createPriceAlert } from "@trbot/market/alert.ts"
import { priceAlertApplicationEvent } from "./chat-price-alert-event.ts"

const NOW = 1_786_000_000_000

test("builds an idempotent event from facts and the stored continuation", () => {
  const alert = {
    ...createPriceAlert({
      instrumentUid: "instrument-1",
      symbol: "F_ASELS0826",
      displayName: "ASELS",
      direction: "ABOVE",
      kind: "PRICE",
      value: 420,
      basis: "TOUCH",
      interval: null,
      repeat: "ONCE",
      referencePrice: 400,
      atrValue: null,
      chatSessionId: "chat-1",
      onTrigger: "Reassess the breakout and decide whether another watch is useful.",
    }, NOW),
    status: "TRIGGERED" as const,
    triggeredAt: NOW + 1_000,
    triggeredPrice: 421,
    triggerId: "trigger-1",
  }

  const queued = priceAlertApplicationEvent({ alert, price: 421, priceAgeMs: 10 })

  expect(queued).toMatchObject({
    sessionId: "chat-1",
    event: {
      key: "price-alert:trigger-1",
      text: "ASELS crossed above 420 at 421.",
    },
  })
  expect(queued?.event.prompt).toContain("Reassess the breakout and decide whether another watch is useful.")
  expect(queued?.event.prompt).not.toContain("notify the trader")
})
