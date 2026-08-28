import { Type } from "@earendil-works/pi-ai"
import type {
  ChatQuestionAnswer,
  ChatQuestionPrompt,
} from "@trbot/chat/question.ts"
import { toolText, type ChatTool } from "./tool.ts"

const QuestionOption = Type.Object({
  label: Type.String({ description: "Display text (1-5 words, concise)", minLength: 1 }),
  description: Type.String({ description: "Brief explanation of this choice", minLength: 1 }),
})

const QuestionPrompt = Type.Object({
  question: Type.String({ description: "Complete question", minLength: 1 }),
  header: Type.String({ description: "Very short label (max 30 characters)", minLength: 1, maxLength: 30 }),
  options: Type.Array(QuestionOption, { description: "Available choices" }),
  multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
})

const AskQuestionParameters = Type.Object({
  questions: Type.Array(QuestionPrompt, { description: "Questions to ask", minItems: 1 }),
})

export interface ChatQuestionAsker {
  ask(input: {
    sessionId: string
    questions: ChatQuestionPrompt[]
    signal?: AbortSignal
  }): Promise<ChatQuestionAnswer[]>
}

/** Pauses an agent turn until the user answers or dismisses its questions. */
export function askQuestionTool(questions: ChatQuestionAsker): ChatTool<typeof AskQuestionParameters> {
  return {
    definition: {
      name: "ask_question",
      description: [
        "Ask the user questions during execution when a preference, requirement, or decision is needed.",
        "A custom-answer option is added automatically; do not add Other or a catch-all option.",
        "Answers are returned as arrays of labels. Set multiple to true to allow more than one answer.",
        'Put a recommended option first and end its label with "(Recommended)".',
      ].join(" "),
      parameters: AskQuestionParameters,
    },
    run: async (params, options) => {
      if (!options.chatSessionId) throw new Error("Questions must belong to a chat session")
      const answers = await questions.ask({
        sessionId: options.chatSessionId,
        questions: params.questions,
        signal: options.signal,
      })
      const formatted = params.questions
        .map((question, index) => (
          `"${question.question}"="${answers[index]?.length ? answers[index]!.join(", ") : "Unanswered"}"`
        ))
        .join(", ")
      return {
        blocks: [toolText(`The user answered: ${formatted}.`)],
        modelBlocks: [toolText(`The user answered: ${formatted}. Continue with these answers in mind.`)],
        isError: false,
      }
    },
  }
}
