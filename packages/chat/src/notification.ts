import { z } from "zod"

export const CHAT_NOTIFICATION_URGENCIES = ["INFO", "IMPORTANT", "URGENT"] as const
export type ChatNotificationUrgency = (typeof CHAT_NOTIFICATION_URGENCIES)[number]

/** A durable notice emitted by an agent and owned by its originating chat. */
export const ChatNotificationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1).max(80),
  message: z.string().min(1).max(1_000),
  urgency: z.enum(CHAT_NOTIFICATION_URGENCIES),
  createdAt: z.number().int().nonnegative(),
})

export type ChatNotification = z.infer<typeof ChatNotificationSchema>

export interface ChatNotificationStore {
  list(): Promise<ChatNotification[]>
  put(notification: ChatNotification): Promise<void>
  remove(id: string): Promise<void>
}
