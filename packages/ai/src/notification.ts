import { Type } from "@earendil-works/pi-ai"
import type { ChatNotification, ChatNotificationUrgency } from "@trbot/chat/notification.ts"
import { toolText, type ChatTool } from "./tool.ts"

const MAX_NOTIFICATIONS_PER_TURN = 3

const NotifyUserParameters = Type.Object({
  title: Type.String({ description: "Short notification title", minLength: 1, maxLength: 80 }),
  message: Type.String({ description: "Concise information the user should notice", minLength: 1, maxLength: 1_000 }),
  urgency: Type.Optional(Type.Union([
    Type.Literal("INFO"),
    Type.Literal("IMPORTANT"),
    Type.Literal("URGENT"),
  ], { description: "Importance of the notice; defaults to INFO" })),
})

export interface ChatNotifier {
  notify(input: {
    sessionId: string
    title: string
    message: string
    urgency: ChatNotificationUrgency
  }): Promise<ChatNotification>
}

/** Sends a durable, non-blocking notice owned by the current chat. */
export function notifyUserTool(notifications: ChatNotifier): ChatTool<typeof NotifyUserParameters> {
  return {
    definition: {
      name: "notify_user",
      description: [
        "Send the user a durable notification without pausing this turn.",
        "Use it for a significant result or event worth noticing while the user may be viewing another screen, not for routine progress updates.",
        `At most ${MAX_NOTIFICATIONS_PER_TURN} notifications may be sent across all agents in one turn; the allowance resets on the next user or application turn.`,
        "The notification opens this chat and never performs a trade or other action.",
      ].join(" "),
      parameters: NotifyUserParameters,
    },
    run: async ({ title, message, urgency }, options) => {
      if (!options.chatSessionId) throw new Error("Notifications must belong to a chat session")
      const cleanTitle = title.trim()
      const cleanMessage = message.trim()
      if (!cleanTitle || !cleanMessage) throw new Error("Notification title and message cannot be blank")
      const budget = options.notificationBudget ?? { sent: 0 }
      if (budget.sent >= MAX_NOTIFICATIONS_PER_TURN) {
        return {
          blocks: [toolText(`Notification limit reached (${MAX_NOTIFICATIONS_PER_TURN} per turn). Continue without sending another notification; the allowance resets on the next user or application turn.`)],
          details: null,
          isError: true,
        }
      }
      budget.sent += 1
      let notification: ChatNotification
      try {
        notification = await notifications.notify({
          sessionId: options.chatSessionId,
          title: cleanTitle,
          message: cleanMessage,
          urgency: urgency ?? "INFO",
        })
      } catch (error) {
        budget.sent -= 1
        throw error
      }
      return {
        blocks: [toolText(`Notified the user: ${notification.title}`)],
        details: { notification },
        isError: false,
      }
    },
  }
}
