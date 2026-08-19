import type { ChatMessage, ChatModelChoice, ChatRunStatus, ChatSession, ChatSessionDetail } from "@trbot/chat/session.ts"
import type { ChatSessions } from "@trbot/protocol/chat.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { HttpClient } from "./http.ts"
import type { StreamConnection } from "./stream.ts"

export class HttpChatSessions implements ChatSessions {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ChatSession[]> {
    return this.http.get<ChatSession[]>(ROUTES.chatSessions)
  }

  create(choice?: ChatModelChoice): Promise<ChatSession> {
    return this.http.post<ChatSession>(ROUTES.chatSessions, choice ? { body: choice } : {})
  }

  configure(sessionId: string, choice: ChatModelChoice): Promise<ChatSession> {
    return this.http.patch<ChatSession>(ROUTES.chatSession(sessionId), { body: choice })
  }

  get(sessionId: string): Promise<ChatSessionDetail> {
    return this.http.get<ChatSessionDetail>(ROUTES.chatSession(sessionId))
  }

  async delete(sessionId: string): Promise<void> {
    await this.http.delete(ROUTES.chatSession(sessionId))
  }

  send(sessionId: string, text: string): Promise<ChatMessage> {
    return this.http.post<ChatMessage>(ROUTES.chatMessages(sessionId), { body: { text } })
  }

  async cancel(sessionId: string, messageId: string): Promise<void> {
    await this.http.delete(ROUTES.chatMessage(sessionId, messageId))
  }

  async abort(sessionId: string): Promise<void> {
    await this.http.post(ROUTES.chatAbort(sessionId))
  }
}

export interface ChatEvents {
  onSessions?: (sessions: ChatSession[]) => void
  onMessage?: (sessionId: string, message: ChatMessage) => void
  onMessageRemoved?: (sessionId: string, messageId: string) => void
  onDelta?: (sessionId: string, runId: string, delta: ChatDelta) => void
  onRun?: (sessionId: string, runId: string, status: ChatRunStatus, error?: string) => void
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

  constructor(connection: StreamConnection, events: ChatEvents) {
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
          events.onDelta?.(frame.sessionId, frame.runId, {
            ...(frame.text !== undefined ? { text: frame.text } : {}),
            ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
            ...(frame.toolName !== undefined ? { toolName: frame.toolName } : {}),
          })
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
        default:
          return
      }
    })
  }
}
