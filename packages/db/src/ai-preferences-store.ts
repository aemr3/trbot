import { eq } from "drizzle-orm"
import type { AiModelChoice, AiPreferencesRecord, AiPreferencesStore } from "@trbot/ai/credential-store.ts"
import type { AppDatabase } from "./client.ts"
import { aiPreferences } from "./schema.ts"

/** One row, because there is one answer to "which model" per place that asks. */
const PREFERENCES_ID = "default"

/**
 * The chosen models.
 *
 * A half-written choice — a provider with no model — reads back as no choice at all,
 * so a picker cannot leave the overview pointing at a provider without saying which of
 * its models to use.
 */
export class DrizzleAiPreferencesStore implements AiPreferencesStore {
  constructor(private readonly db: AppDatabase) {}

  async get(): Promise<AiPreferencesRecord | null> {
    const [row] = await this.db.select().from(aiPreferences).where(eq(aiPreferences.id, PREFERENCES_ID)).limit(1)
    if (!row) return null
    return {
      overview: toChoice(row.overviewProvider, row.overviewModel, row.overviewReasoning),
      chat: toChoice(row.chatProvider, row.chatModel, row.chatReasoning),
      updatedAt: row.updatedAt,
    }
  }

  async put(preferences: {
    overview: AiModelChoice | null
    chat: AiModelChoice | null
  }): Promise<AiPreferencesRecord> {
    const updatedAt = Date.now()
    const row = {
      id: PREFERENCES_ID,
      overviewProvider: preferences.overview?.providerId ?? null,
      overviewModel: preferences.overview?.modelId ?? null,
      overviewReasoning: preferences.overview?.reasoning ?? null,
      chatProvider: preferences.chat?.providerId ?? null,
      chatModel: preferences.chat?.modelId ?? null,
      chatReasoning: preferences.chat?.reasoning ?? null,
      updatedAt,
    }
    await this.db.insert(aiPreferences).values(row).onConflictDoUpdate({ target: aiPreferences.id, set: row })
    return { overview: preferences.overview, chat: preferences.chat, updatedAt }
  }
}

function toChoice(providerId: string | null, modelId: string | null, reasoning: string | null): AiModelChoice | null {
  if (!providerId || !modelId) return null
  return { providerId, modelId, reasoning }
}
