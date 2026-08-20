import type { ChatApplicationEvent } from "@trbot/chat/session.ts"
import type { MarketMonitorTriggerEvent } from "./monitors/market-monitor.ts"

/** Converts a durable market crossing into one idempotent, application-owned chat input. */
export function marketMonitorApplicationEvent(event: MarketMonitorTriggerEvent): {
  sessionId: string
  event: ChatApplicationEvent
} | null {
  const { alert: monitor } = event
  if (!monitor.triggerId || monitor.triggeredAt === null) return null
  const side = monitor.direction === "ABOVE" ? "above" : "below"
  const display = `${monitor.displayName} crossed ${side} ${monitor.triggerPrice} at ${event.price}.`
  const prompt = [
    "<market_monitor_triggered>",
    `trigger_id: ${monitor.triggerId}`,
    `monitor_id: ${monitor.id}`,
    `symbol: ${monitor.symbol}`,
    `display_name: ${monitor.displayName}`,
    `condition: crossed ${side} ${monitor.triggerPrice}`,
    `observed_price: ${event.price}`,
    `triggered_at: ${new Date(monitor.triggeredAt).toISOString()}`,
    "<continuation>",
    monitor.onTrigger,
    "</continuation>",
    "</market_monitor_triggered>",
  ].join("\n")
  return {
    sessionId: monitor.chatSessionId,
    event: { key: `market-monitor:${monitor.triggerId}`, label: "market monitor", text: display, prompt },
  }
}
