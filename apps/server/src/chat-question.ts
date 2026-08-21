import type { ChatQuestionAsker } from "@trbot/ai/question.ts"
import type {
  ChatQuestionAnswer,
  ChatQuestionRequest,
  ChatQuestionStore,
} from "@trbot/chat/question.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

interface PendingQuestion {
  request: ChatQuestionRequest
  resolve?: (answers: ChatQuestionAnswer[]) => void
  reject?: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface ChatQuestionControllerOptions {
  store: ChatQuestionStore
  broadcast: (frame: ChatFrame) => void
  onDetachedAnswer?: (request: ChatQuestionRequest, answers: ChatQuestionAnswer[]) => Promise<void>
  onDetachedReject?: (request: ChatQuestionRequest) => Promise<void>
  now?: () => number
}

/** Coordinates agent tool calls that are waiting for a user response. */
export class ChatQuestionController implements ChatQuestionAsker {
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly now: () => number
  private destroyed = false

  constructor(private readonly options: ChatQuestionControllerOptions) {
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    this.pending.clear()
    for (const request of await this.options.store.list()) {
      this.pending.set(request.id, { request })
    }
  }

  /** Reconciles database cascades after a chat is deleted. */
  async sync(): Promise<void> {
    const stored = new Set((await this.options.store.list()).map((request) => request.id))
    for (const [id, pending] of this.pending) {
      if (stored.has(id)) continue
      this.pending.delete(id)
      this.removeAbortListener(pending)
      this.options.broadcast({ type: "chatQuestionResolved", requestId: id, sessionId: pending.request.sessionId })
      pending.reject?.(new Error("The question's chat was deleted"))
    }
  }

  async ask(input: Parameters<ChatQuestionAsker["ask"]>[0]): Promise<ChatQuestionAnswer[]> {
    if (this.destroyed) return Promise.reject(new Error("Question service is shutting down"))
    if (input.signal?.aborted) return Promise.reject(abortError())

    const request: ChatQuestionRequest = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      questions: input.questions,
    }

    await this.options.store.put(request, this.now())
    if (input.signal?.aborted) {
      await this.options.store.remove(request.id)
      throw abortError()
    }

    return await new Promise<ChatQuestionAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = { request, resolve, reject, signal: input.signal }
      if (input.signal) {
        pending.onAbort = () => void this.abort(request.id)
        input.signal.addEventListener("abort", pending.onAbort, { once: true })
      }
      this.pending.set(request.id, pending)
      this.options.broadcast({ type: "chatQuestionAsked", request })
    })
  }

  list(): ChatQuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  async reply(requestId: string, answers: ChatQuestionAnswer[]): Promise<void> {
    const pending = this.require(requestId)
    validateAnswers(pending.request, answers)
    if (!pending.resolve) await this.options.onDetachedAnswer?.(pending.request, answers)
    await this.finish(pending, { answers })
  }

  async reject(requestId: string): Promise<void> {
    const pending = this.require(requestId)
    if (!pending.reject) await this.options.onDetachedReject?.(pending.request)
    await this.finish(pending, { error: new Error("The user dismissed the question") })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const pending of this.pending.values()) {
      this.removeAbortListener(pending)
      pending.reject?.(new Error("Question service is shutting down"))
    }
    this.pending.clear()
  }

  backlog(): ChatFrame[] {
    return this.list().map((request) => ({ type: "chatQuestionAsked", request }))
  }

  private require(requestId: string): PendingQuestion {
    const pending = this.pending.get(requestId)
    if (!pending) throw new ProtocolError("not_found", "No such pending question")
    return pending
  }

  private async finish(
    pending: PendingQuestion,
    outcome: { answers: ChatQuestionAnswer[] } | { error: Error },
  ): Promise<void> {
    await this.options.store.remove(pending.request.id)
    this.pending.delete(pending.request.id)
    this.removeAbortListener(pending)
    this.options.broadcast({
      type: "chatQuestionResolved",
      requestId: pending.request.id,
      sessionId: pending.request.sessionId,
    })
    if ("answers" in outcome) pending.resolve?.(outcome.answers)
    else pending.reject?.(outcome.error)
  }

  private async abort(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId)
    if (!pending) return
    await this.options.store.remove(requestId)
    this.pending.delete(requestId)
    this.removeAbortListener(pending)
    this.options.broadcast({
      type: "chatQuestionResolved",
      requestId,
      sessionId: pending.request.sessionId,
    })
    pending.reject?.(abortError())
  }

  private removeAbortListener(pending: PendingQuestion): void {
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
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
