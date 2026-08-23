import {
  ChatCompactionReportSchema,
  CHAT_TIMELINE_LIMIT,
  ChatMessageSchema,
  ChatSessionDetailSchema,
  ChatSessionSchema,
  ChatUndoPreviewSchema,
  ChatUndoResultSchema,
  type ChatMessage,
  type ChatCompactionReport,
  type ChatModelChoice,
  type ChatRunStatus,
  type ChatSession,
  type ChatSessionDetail,
  type ChatUndoPreview,
  type ChatUndoResult,
} from "@trbot/chat/session.ts"
import { ChatQuestionRequestSchema, type ChatQuestionAnswer, type ChatQuestionRequest } from "@trbot/chat/question.ts"
import { ChatNotificationSchema, type ChatNotification } from "@trbot/chat/notification.ts"
import {
  ChatPermissionRequestSchema,
  type ChatPermissionReply,
  type ChatPermissionRequest,
} from "@trbot/chat/permission.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import {
  ChatAutomationStateSchema,
  ChatGoalSchema,
  ChatLoopSchema,
  type ChatAutomationState,
  type ChatGoal,
  type ChatLoop,
  type CreateChatGoal,
  type CreateChatLoop,
  type UpdateChatGoal,
} from "@trbot/chat/automation.ts"
import {
  ChatMobilePairingSchema,
  ChatMobileStateSchema,
  type ChatMobilePairing,
  type ChatMobileState,
} from "@trbot/chat/mobile.ts"
import { OkResponseSchema, ROUTES } from "@trbot/protocol/routes.ts"
import type { HttpClient } from "./http.ts"
import type { StreamConnection } from "./stream.ts"
import { z } from "zod"

export class HttpChatSessions implements ChatSessions {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ChatSession[]> {
    return this.http.get(ROUTES.chatSessions, z.array(ChatSessionSchema))
  }

  children(sessionId: string): Promise<ChatSession[]> {
    return this.http.get(ROUTES.chatSessionChildren(sessionId), z.array(ChatSessionSchema))
  }

  create(choice?: ChatModelChoice): Promise<ChatSession> {
    return this.http.post(ROUTES.chatSessions, ChatSessionSchema, choice ? { body: choice } : {})
  }

  configure(sessionId: string, choice: ChatModelChoice): Promise<ChatSession> {
    return this.http.patch(ROUTES.chatSession(sessionId), ChatSessionSchema, { body: choice })
  }

  get(sessionId: string): Promise<ChatSessionDetail> {
    return this.http.get(ROUTES.chatSession(sessionId), ChatSessionDetailSchema, {
      query: { limit: String(CHAT_TIMELINE_LIMIT) },
    })
  }

  async delete(sessionId: string): Promise<void> {
    await this.http.delete(ROUTES.chatSession(sessionId), OkResponseSchema)
  }

  send(sessionId: string, text: string): Promise<ChatMessage> {
    return this.http.post(ROUTES.chatMessages(sessionId), ChatMessageSchema, { body: { text } })
  }

  async cancel(sessionId: string, messageId: string): Promise<void> {
    await this.http.delete(ROUTES.chatMessage(sessionId, messageId), OkResponseSchema)
  }

  undo(sessionId: string, messageId: string, revertEffects = false): Promise<ChatUndoResult> {
    return this.http.post(ROUTES.chatUndo(sessionId), ChatUndoResultSchema, {
      body: { messageId, revertEffects },
    })
  }

  previewUndo(sessionId: string, messageId: string): Promise<ChatUndoPreview> {
    return this.http.post(ROUTES.chatUndoPreview(sessionId), ChatUndoPreviewSchema, { body: { messageId } })
  }

  async abort(sessionId: string): Promise<void> {
    await this.http.post(ROUTES.chatAbort(sessionId), OkResponseSchema)
  }

  compact(sessionId: string): Promise<ChatCompactionReport> {
    return this.http.post(ROUTES.chatCompact(sessionId), ChatCompactionReportSchema)
  }

  mobile(sessionId: string): Promise<ChatMobileState> {
    return this.http.get(ROUTES.chatMobile(sessionId), ChatMobileStateSchema)
  }

  connectMobile(sessionId: string): Promise<ChatMobilePairing> {
    return this.http.post(ROUTES.chatMobile(sessionId), ChatMobilePairingSchema)
  }

  async disconnectMobile(sessionId: string): Promise<void> {
    await this.http.delete(ROUTES.chatMobile(sessionId), OkResponseSchema)
  }

  automations(sessionId: string): Promise<ChatAutomationState> {
    return this.http.get(ROUTES.chatAutomations(sessionId), ChatAutomationStateSchema)
  }

  createGoal(sessionId: string, input: CreateChatGoal): Promise<ChatGoal> {
    return this.http.put(ROUTES.chatGoal(sessionId), ChatGoalSchema, { body: input })
  }

  updateGoal(sessionId: string, input: UpdateChatGoal): Promise<ChatGoal | null> {
    return this.http.patch(ROUTES.chatGoal(sessionId), ChatGoalSchema.nullable(), { body: input })
  }

  createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop> {
    return this.http.post(ROUTES.chatLoops(sessionId), ChatLoopSchema, { body: input })
  }

  async cancelLoop(sessionId: string, loopId: string): Promise<void> {
    await this.http.delete(ROUTES.chatLoop(sessionId, loopId), OkResponseSchema)
  }

  questions(): Promise<ChatQuestionRequest[]> {
    return this.http.get(ROUTES.chatQuestions, z.array(ChatQuestionRequestSchema))
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswer[]): Promise<void> {
    await this.http.post(ROUTES.chatQuestionReply(requestId), OkResponseSchema, { body: { answers } })
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.http.delete(ROUTES.chatQuestion(requestId), OkResponseSchema)
  }

  permissions(): Promise<ChatPermissionRequest[]> {
    return this.http.get(ROUTES.chatPermissions, z.array(ChatPermissionRequestSchema))
  }

  async answerPermission(requestId: string, reply: ChatPermissionReply): Promise<void> {
    await this.http.post(ROUTES.chatPermissionReply(requestId), OkResponseSchema, { body: reply })
  }

  notifications(): Promise<ChatNotification[]> {
    return this.http.get(ROUTES.chatNotifications, z.array(ChatNotificationSchema))
  }

  async dismissNotification(notificationId: string): Promise<void> {
    await this.http.delete(ROUTES.chatNotification(notificationId), OkResponseSchema)
  }
}

export interface ChatEvents {
  onSessions?: (sessions: ChatSession[]) => void
  onMessage?: (sessionId: string, message: ChatMessage) => void
  onMessageRemoved?: (sessionId: string, messageId: string) => void
  onDelta?: (sessionId: string, runId: string, delta: ChatDelta) => void
  onRun?: (sessionId: string, runId: string, status: ChatRunStatus, error?: string) => void
  onQuestionAsked?: (request: ChatQuestionRequest) => void
  onQuestionResolved?: (sessionId: string, requestId: string) => void
  onPermissionRequested?: (request: ChatPermissionRequest) => void
  onPermissionResolved?: (sessionId: string, requestId: string) => void
  onNotification?: (notification: ChatNotification) => void
  onNotificationDismissed?: (notificationId: string) => void
  /**
   * Asked when this client can tell it is not seeing the whole run: a delta
   * arrived out of order, or a run is reported that it holds no partial for. The
   * answer is to re-read the session rather than render a transcript with a hole.
   */
  onResync?: (sessionId: string) => void
}

export interface ChatDelta {
  text?: string
  reasoning?: string
  toolName?: string
}

/**
 * What the server is doing with each conversation.
 *
 * Runs belong to the server, so these frames arrive whether or not this terminal
 * asked for the reply, and whether or not it is showing the chat. `seq` is how a
 * client notices it fell behind — a socket that dropped a frame would otherwise
 * render a reply with a piece missing and never know.
 */
export class ChatClient {
  private readonly seqByRun = new Map<string, number>()

  constructor(connection: Pick<StreamConnection, "on">, events: ChatEvents) {
    connection.on((frame) => {
      switch (frame.type) {
        case "chatSessions":
          events.onSessions?.(frame.sessions)
          return
        case "chatMessage":
          events.onMessage?.(frame.sessionId, frame.message)
          return
        case "chatMessageRemoved":
          events.onMessageRemoved?.(frame.sessionId, frame.messageId)
          return
        case "chatDelta": {
          const expected = (this.seqByRun.get(frame.runId) ?? 0) + 1
          this.seqByRun.set(frame.runId, frame.seq)
          if (frame.seq !== expected) {
            events.onResync?.(frame.sessionId)
            return
          }
          const delta: ChatDelta = {}
          if (frame.text !== undefined) delta.text = frame.text
          if (frame.reasoning !== undefined) delta.reasoning = frame.reasoning
          if (frame.toolName !== undefined) delta.toolName = frame.toolName
          events.onDelta?.(frame.sessionId, frame.runId, delta)
          return
        }
        case "chatRun":
          // A run this client has seen nothing of is one it joined late, which is
          // exactly when the partial has to be fetched.
          if (frame.status === "running" && !this.seqByRun.has(frame.runId)) {
            events.onResync?.(frame.sessionId)
          }
          if (frame.status !== "running") this.seqByRun.delete(frame.runId)
          events.onRun?.(frame.sessionId, frame.runId, frame.status, frame.error)
          return
        case "chatQuestionAsked":
          events.onQuestionAsked?.(frame.request)
          return
        case "chatQuestionResolved":
          events.onQuestionResolved?.(frame.sessionId, frame.requestId)
          return
        case "chatPermissionRequested":
          events.onPermissionRequested?.(frame.request)
          return
        case "chatPermissionResolved":
          events.onPermissionResolved?.(frame.sessionId, frame.requestId)
          return
        case "chatNotification":
          events.onNotification?.(frame.notification)
          return
        case "chatNotificationDismissed":
          events.onNotificationDismissed?.(frame.notificationId)
          return
        default:
          return
      }
    })
  }
}
