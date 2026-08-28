const STEERING_OPEN = "<user-steering>"
const STEERING_CLOSE = "</user-steering>"

/** Marks guidance that modifies the active task instead of starting another one. */
export function steeringPrompt(text: string): string {
  return [
    STEERING_OPEN,
    "The user sent this while you were working. Apply it to the current task now:",
    text,
    STEERING_CLOSE,
  ].join("\n")
}

export function isSteeringPrompt(text: string): boolean {
  return text.startsWith(`${STEERING_OPEN}\n`) && text.endsWith(`\n${STEERING_CLOSE}`)
}
