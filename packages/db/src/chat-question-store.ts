import { asc, eq } from "drizzle-orm"
import {
  ChatQuestionRequestSchema,
  type ChatQuestionRequest,
  type ChatQuestionStore,
} from "@trbot/chat/question.ts"
import type { AppDatabase } from "./client.ts"
import { chatQuestions } from "./schema.ts"

/** Keeps unanswered agent questions until their chat receives an answer. */
export class DrizzleChatQuestionStore implements ChatQuestionStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<ChatQuestionRequest[]> {
    const rows = await this.db.select().from(chatQuestions).orderBy(asc(chatQuestions.createdAt))
    return rows.map((row) => ChatQuestionRequestSchema.parse({
      id: row.id,
      sessionId: row.sessionId,
      questions: JSON.parse(row.questions),
    }))
  }

  async put(request: ChatQuestionRequest, createdAt: number): Promise<void> {
    await this.db.insert(chatQuestions).values({
      id: request.id,
      sessionId: request.sessionId,
      questions: JSON.stringify(request.questions),
      createdAt,
    })
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(chatQuestions).where(eq(chatQuestions.id, id))
  }
}
