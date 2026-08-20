import { expect, test } from "bun:test"
import { createMarketMonitor } from "@trbot/market/market-monitor.ts"
import { marketMonitorApplicationEvent } from "./chat-market-monitor-event.ts"

const NOW = 1_786_000_000_000

test("builds an idempotent event from facts and the stored continuation", () => {
  const monitor = {
    ...createMarketMonitor({
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

  const queued = marketMonitorApplicationEvent({ alert: monitor, price: 421, priceAgeMs: 10 })

  expect(queued).toMatchObject({
    sessionId: "chat-1",
    event: {
      key: "market-monitor:trigger-1",
      text: "ASELS crossed above 420 at 421.",
    },
  })
  expect(queued?.event.prompt).toContain("Reassess the breakout and decide whether another watch is useful.")
  expect(queued?.event.prompt).toContain("<market_monitor_triggered>")
  expect(queued?.event.prompt).toContain("monitor_id: ")
  expect(queued?.event.prompt).not.toContain("alert_id: ")
  expect(queued?.event.prompt).not.toContain("notify the trader")
})
