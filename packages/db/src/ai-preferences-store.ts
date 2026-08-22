import { eq } from "drizzle-orm"
import type { AiModelChoice, AiPreferencesRecord, AiPreferencesStore } from "@trbot/ai/credential-store.ts"
import type { AppDatabase } from "./client.ts"
import { aiPreferences } from "./schema.ts"

/** One row, because there is one answer to "which model" per place that asks. */
const PREFERENCES_ID = "default"

/**
 * The chosen models.
 *
 * A half-written choice — a provider with no model — reads back as no choice at
 * all, so the picker cannot leave chat pointing at an unusable provider.
 */
export class DrizzleAiPreferencesStore implements AiPreferencesStore {
  constructor(private readonly db: AppDatabase) {}

  async get(): Promise<AiPreferencesRecord | null> {
    const [row] = await this.db.select().from(aiPreferences).where(eq(aiPreferences.id, PREFERENCES_ID)).limit(1)
    if (!row) return null
    return {
      chat: toChoice(row.chatProvider, row.chatModel, row.chatReasoning),
      updatedAt: row.updatedAt,
    }
  }

  async put(preferences: {
    chat: AiModelChoice | null
  }): Promise<AiPreferencesRecord> {
    const updatedAt = Date.now()
    const row = {
      id: PREFERENCES_ID,
      chatProvider: preferences.chat?.providerId ?? null,
      chatModel: preferences.chat?.modelId ?? null,
      chatReasoning: preferences.chat?.reasoning ?? null,
      updatedAt,
    }
    await this.db.insert(aiPreferences).values(row).onConflictDoUpdate({ target: aiPreferences.id, set: row })
    return { chat: preferences.chat, updatedAt }
  }
}

function toChoice(providerId: string | null, modelId: string | null, reasoning: string | null): AiModelChoice | null {
  if (!providerId || !modelId) return null
  return { providerId, modelId, reasoning }
}
