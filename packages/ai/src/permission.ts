import type { ChatPermissionResolution, ChatPermissionScope } from "@trbot/chat/permission.ts"
import type { ChatToolRunOptions } from "./tool.ts"

export interface ChatPermissionAuthorizer {
  authorize(input: {
    sessionId: string
    toolName: string
    action: string
    reason?: string
    scope: ChatPermissionScope
    signal?: AbortSignal
  }): Promise<ChatPermissionResolution>
}

/** Pauses a sensitive tool call and lets the user approve it once or for this chat. */
export async function requireToolPermission(
  permissions: ChatPermissionAuthorizer,
  options: ChatToolRunOptions,
  toolName: string,
  action: string,
  reason?: string,
): Promise<void> {
  if (!options.chatSessionId) throw new Error("Sensitive tools must belong to a chat session")
  const resolution = await permissions.authorize({
    sessionId: options.chatSessionId,
    toolName,
    action,
    reason,
    scope: "SESSION",
    signal: options.signal,
  })
  if (resolution.decision === "ALLOW") return
  const explanation = resolution.reason ? ` Reason: ${resolution.reason}` : ""
  throw new Error(`The user denied this action.${explanation} Continue without executing it.`)
}
