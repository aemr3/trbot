/** One choice the agent offers while asking the user a question. */
export interface ChatQuestionOption {
  /** Short display text, suitable for a terminal list. */
  label: string
  /** What choosing this option means. */
  description: string
}

/** One question in an interactive request from an agent. */
export interface ChatQuestionPrompt {
  question: string
  /** Short context label shown above the question. */
  header: string
  options: ChatQuestionOption[]
  /** When true, the user may choose more than one option. */
  multiple?: boolean
}

/** A pending request. Answers use the same order as `questions`. */
export interface ChatQuestionRequest {
  id: string
  sessionId: string
  questions: ChatQuestionPrompt[]
}

export type ChatQuestionAnswer = string[]
