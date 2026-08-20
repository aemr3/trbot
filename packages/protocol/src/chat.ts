import type { ChatCompactionReport, ChatMessage, ChatModelChoice, ChatSession, ChatSessionDetail } from "@trbot/chat/session.ts"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import type {
  ChatAutomationState,
  ChatGoal,
  ChatLoop,
  CreateChatGoal,
  CreateChatLoop,
  UpdateChatGoal,
} from "@trbot/chat/automation.ts"

/**
 * The chat as a client drives it.
 *
 * Sending never fails for being busy: a message is queued and the server works
 * through the queue, so two messages in a row are two turns in order rather than
 * an error the trader has to notice and retry. What comes back is the queued
 * message itself, which is what the transcript shows until its turn runs.
 */
export interface ChatSessions {
  list(): Promise<ChatSession[]>
  /** Isolated worker sessions spawned directly from this conversation. */
  children(sessionId: string): Promise<ChatSession[]>
  /** Started on a chosen model, or on whatever is the current default. */
  create(choice?: ChatModelChoice): Promise<ChatSession>
  /** Points a session at a different model, from its next turn onwards. */
  configure(sessionId: string, choice: ChatModelChoice): Promise<ChatSession>
  get(sessionId: string): Promise<ChatSessionDetail>
  delete(sessionId: string): Promise<void>
  send(sessionId: string, text: string): Promise<ChatMessage>
  /** Takes back a message that has not had its turn yet. */
  cancel(sessionId: string, messageId: string): Promise<void>
  /** Stops the reply being generated now, keeping whatever it produced. */
  abort(sessionId: string): Promise<void>
  /** Replaces the current model-facing history with a fresh rolling summary. */
  compact(sessionId: string): Promise<ChatCompactionReport>
  automations(sessionId: string): Promise<ChatAutomationState>
  createGoal(sessionId: string, input: CreateChatGoal): Promise<ChatGoal>
  updateGoal(sessionId: string, input: UpdateChatGoal): Promise<ChatGoal | null>
  createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop>
  cancelLoop(sessionId: string, loopId: string): Promise<void>
  /** Questions currently blocking an agent tool call. */
  questions(): Promise<ChatQuestionRequest[]>
  answerQuestion(requestId: string, answers: ChatQuestionAnswer[]): Promise<void>
  rejectQuestion(requestId: string): Promise<void>
  /** Durable agent notices waiting for the user to acknowledge them. */
  notifications(): Promise<ChatNotification[]>
  dismissNotification(notificationId: string): Promise<void>
}
