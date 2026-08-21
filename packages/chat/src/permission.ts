import { z } from "zod"

export const CHAT_PERMISSION_SCOPES = ["SESSION", "ONCE"] as const
export type ChatPermissionScope = (typeof CHAT_PERMISSION_SCOPES)[number]

/** A tool call waiting for the user to authorize it. */
export const ChatPermissionRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  action: z.string().min(1).max(1_000),
  reason: z.string().min(1).max(1_000).nullable(),
  scope: z.enum(CHAT_PERMISSION_SCOPES),
  createdAt: z.number().int().nonnegative(),
})

export type ChatPermissionRequest = z.infer<typeof ChatPermissionRequestSchema>

export const ChatPermissionDecisionSchema = z.enum(["ALLOW", "DENY"])
export type ChatPermissionDecision = z.infer<typeof ChatPermissionDecisionSchema>

export const ChatPermissionReplySchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ALLOW"),
    scope: z.enum(CHAT_PERMISSION_SCOPES),
  }),
  z.object({
    decision: z.literal("DENY"),
    reason: z.string().trim().min(1).max(1_000).optional(),
  }),
])
export type ChatPermissionReply = z.infer<typeof ChatPermissionReplySchema>

/** The decision returned to the blocked tool call. */
export interface ChatPermissionResolution {
  decision: ChatPermissionDecision
  reason: string | null
}

/** Durable pending requests. Session grants belong to the live permission controller. */
export interface ChatPermissionStore {
  listRequests(): Promise<ChatPermissionRequest[]>
  putRequest(request: ChatPermissionRequest): Promise<void>
  removeRequest(id: string): Promise<void>
}
