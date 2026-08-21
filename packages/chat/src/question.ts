import { z } from "zod"

/** One choice the agent offers while asking the user a question. */
export const ChatQuestionOptionSchema = z.object({
  /** Short display text, suitable for a terminal list. */
  label: z.string().min(1),
  /** What choosing this option means. */
  description: z.string().min(1),
})

export type ChatQuestionOption = z.infer<typeof ChatQuestionOptionSchema>

/** One question in an interactive request from an agent. */
export const ChatQuestionPromptSchema = z.object({
  question: z.string().min(1),
  /** Short context label shown above the question. */
  header: z.string().min(1).max(30),
  options: z.array(ChatQuestionOptionSchema),
  /** When true, the user may choose more than one option. */
  multiple: z.boolean().optional(),
})

export type ChatQuestionPrompt = z.infer<typeof ChatQuestionPromptSchema>

/** A pending request. Answers use the same order as `questions`. */
export const ChatQuestionRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  questions: z.array(ChatQuestionPromptSchema).min(1),
})

export type ChatQuestionRequest = z.infer<typeof ChatQuestionRequestSchema>

export const ChatQuestionAnswerSchema = z.array(z.string().min(1))
export const ChatQuestionAnswersSchema = z.array(ChatQuestionAnswerSchema)
export const ChatQuestionReplySchema = z.object({ answers: ChatQuestionAnswersSchema })

export type ChatQuestionAnswer = z.infer<typeof ChatQuestionAnswerSchema>

/** Durable pending questions; resolved answers remain in the chat tool result. */
export interface ChatQuestionStore {
  list(): Promise<ChatQuestionRequest[]>
  put(request: ChatQuestionRequest, createdAt: number): Promise<void>
  remove(id: string): Promise<void>
}
