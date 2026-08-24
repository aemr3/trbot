import { z } from "zod"

export const CHAT_MOBILE_CHANNELS = ["telegram"] as const
export const ChatMobileChannelSchema = z.enum(CHAT_MOBILE_CHANNELS)
export type ChatMobileChannel = z.infer<typeof ChatMobileChannelSchema>

/** The safe connection details a client may display. External account ids stay server-side. */
export const ChatMobileConnectionSchema = z.object({
  sessionId: z.string().min(1),
  channel: ChatMobileChannelSchema,
  displayName: z.string().min(1),
  connectedAt: z.number().int().nonnegative(),
})
export type ChatMobileConnection = z.infer<typeof ChatMobileConnectionSchema>

export const ChatMobileStateSchema = z.object({
  available: z.boolean(),
  connection: ChatMobileConnectionSchema.nullable(),
})
export type ChatMobileState = z.infer<typeof ChatMobileStateSchema>

export const ChatMobilePairingSchema = z.object({
  channel: ChatMobileChannelSchema,
  url: z.string().url(),
  expiresAt: z.number().int().nonnegative(),
})
export type ChatMobilePairing = z.infer<typeof ChatMobilePairingSchema>

/** Server-only routing details for one chat attached to an external mobile channel. */
export const ChatMobileBindingSchema = ChatMobileConnectionSchema.extend({
  externalUserId: z.string().min(1),
  externalChatId: z.string().min(1),
  /** Silences routine conversation traffic, never prompts that require attention. */
  notificationsMuted: z.boolean().default(false),
})
export type ChatMobileBinding = z.infer<typeof ChatMobileBindingSchema>

/** Telegram messages belonging to one application prompt, kept until that prompt is undone. */
export const ChatMobileTurnSchema = z.object({
  sessionId: z.string().min(1),
  promptMessageId: z.string().min(1),
  channel: ChatMobileChannelSchema,
  externalChatId: z.string().min(1),
  externalMessageIds: z.array(z.number().int().positive()),
  createdAt: z.number().int().nonnegative(),
})
export type ChatMobileTurn = z.infer<typeof ChatMobileTurnSchema>

export const ChatMobileTurnMessageSchema = ChatMobileTurnSchema.pick({
  sessionId: true,
  promptMessageId: true,
  channel: true,
  externalChatId: true,
  createdAt: true,
}).extend({
  externalMessageId: z.number().int().positive(),
})
export type ChatMobileTurnMessage = z.infer<typeof ChatMobileTurnMessageSchema>

export interface ChatMobileStore {
  list(): Promise<ChatMobileBinding[]>
  findBySession(sessionId: string): Promise<ChatMobileBinding | null>
  findByExternalUser(channel: ChatMobileChannel, externalUserId: string): Promise<ChatMobileBinding | null>
  /** A mobile account and a chat may each have only one current binding. */
  connect(binding: ChatMobileBinding): Promise<void>
  setNotificationsMuted(sessionId: string, muted: boolean): Promise<void>
  removeSession(sessionId: string): Promise<void>
  /** Adds one Telegram message to the turn anchored by an application prompt. */
  recordTurnMessage(message: ChatMobileTurnMessage): Promise<void>
  findTurn(
    promptMessageId: string,
    channel: ChatMobileChannel,
    externalChatId: string,
  ): Promise<ChatMobileTurn | null>
  /** Atomically claims every external copy of a turn for message deletion. */
  takeTurns(promptMessageId: string): Promise<ChatMobileTurn[]>
}
