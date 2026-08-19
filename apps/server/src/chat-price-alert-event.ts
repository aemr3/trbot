import type { ChatApplicationEvent } from "@trbot/chat/session.ts"
import type { AlertTriggerEvent } from "@trbot/market/alert-monitor.ts"

/** Converts a durable market crossing into one idempotent, application-owned chat input. */
export function priceAlertApplicationEvent(event: AlertTriggerEvent): {
  sessionId: string
  event: ChatApplicationEvent
} | null {
  const { alert } = event
  if (!alert.chatSessionId || !alert.onTrigger || !alert.triggerId || alert.triggeredAt === null) return null
  const side = alert.direction === "ABOVE" ? "above" : "below"
  const display = `${alert.displayName} crossed ${side} ${alert.triggerPrice} at ${event.price}.`
  const prompt = [
    "<price_alert_triggered>",
    `trigger_id: ${alert.triggerId}`,
    `alert_id: ${alert.id}`,
    `symbol: ${alert.symbol}`,
    `display_name: ${alert.displayName}`,
    `condition: crossed ${side} ${alert.triggerPrice}`,
    `observed_price: ${event.price}`,
    `triggered_at: ${new Date(alert.triggeredAt).toISOString()}`,
    "<continuation>",
    alert.onTrigger,
    "</continuation>",
    "</price_alert_triggered>",
  ].join("\n")
  return {
    sessionId: alert.chatSessionId,
    event: { key: `price-alert:${alert.triggerId}`, text: display, prompt },
  }
}
