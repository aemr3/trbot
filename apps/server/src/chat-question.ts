import type { ChatQuestionAsker } from "@trbot/ai/question.ts"
import type {
  ChatQuestionAnswer,
  ChatQuestionRequest,
} from "@trbot/chat/question.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

interface PendingQuestion {
  request: ChatQuestionRequest
  resolve: (answers: ChatQuestionAnswer[]) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface ChatQuestionControllerOptions {
  broadcast: (frame: ChatFrame) => void
}

/** Coordinates agent tool calls that are waiting for a user response. */
export class ChatQuestionController implements ChatQuestionAsker {
  private readonly pending = new Map<string, PendingQuestion>()
  private destroyed = false

  constructor(private readonly options: ChatQuestionControllerOptions) {}

  ask(input: Parameters<ChatQuestionAsker["ask"]>[0]): Promise<ChatQuestionAnswer[]> {
    if (this.destroyed) return Promise.reject(new Error("Question service is shutting down"))
    if (input.signal?.aborted) return Promise.reject(abortError())

    const request: ChatQuestionRequest = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      questions: input.questions,
    }

    return new Promise<ChatQuestionAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = { request, resolve, reject, signal: input.signal }
      if (input.signal) {
        pending.onAbort = () => this.settle(request.id, { error: abortError() })
        input.signal.addEventListener("abort", pending.onAbort, { once: true })
      }
      this.pending.set(request.id, pending)
      this.options.broadcast({ type: "chatQuestionAsked", request })
    })
  }

  list(): ChatQuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  reply(requestId: string, answers: ChatQuestionAnswer[]): void {
    const pending = this.require(requestId)
    validateAnswers(pending.request, answers)
    this.settle(requestId, { answers })
  }

  reject(requestId: string): void {
    this.require(requestId)
    this.settle(requestId, { error: new Error("The user dismissed the question") })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const id of this.pending.keys()) {
      this.settle(id, { error: new Error("Question service is shutting down") })
    }
  }

  backlog(): ChatFrame[] {
    return this.list().map((request) => ({ type: "chatQuestionAsked", request }))
  }

  private require(requestId: string): PendingQuestion {
    const pending = this.pending.get(requestId)
    if (!pending) throw new ProtocolError("not_found", "No such pending question")
    return pending
  }

  private settle(
    requestId: string,
    outcome: { answers: ChatQuestionAnswer[] } | { error: Error },
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
    this.options.broadcast({
      type: "chatQuestionResolved",
      requestId,
      sessionId: pending.request.sessionId,
    })
    if ("answers" in outcome) pending.resolve(outcome.answers)
    else pending.reject(outcome.error)
  }
}

function validateAnswers(request: ChatQuestionRequest, answers: ChatQuestionAnswer[]): void {
  if (answers.length !== request.questions.length) {
    throw new ProtocolError("invalid_request", "Answers must match the questions in order")
  }
  answers.forEach((answer, index) => {
    const question = request.questions[index]
    if (!question?.multiple && answer.length > 1) {
      throw new ProtocolError("invalid_request", `Question ${index + 1} accepts only one answer`)
    }
    if (answer.some((value) => !value.trim())) {
      throw new ProtocolError("invalid_request", `Question ${index + 1} contains an empty answer`)
    }
  })
}

function abortError(): Error {
  return new DOMException("The question was cancelled", "AbortError")
}
