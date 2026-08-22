/**
 * A stored provider credential.
 *
 * `credential` is the harness's own record and is deliberately opaque here: it is an
 * API key for most providers and an OAuth grant for the subscription ones, and only
 * the harness ever looks inside. This application decides where it lives and when it
 * was made, nothing more.
 */
export interface AiCredentialRecord {
  providerId: string
  credential: unknown
  createdAt: number
  updatedAt: number
}

/** Persistence for provider credentials, one row per provider. */
export interface AiCredentialStore {
  get(providerId: string): Promise<AiCredentialRecord | null>
  list(): Promise<AiCredentialRecord[]>
  put(record: AiCredentialRecord): Promise<void>
  delete(providerId: string): Promise<void>
}

/** Which model answers a new chat session. */
export interface AiModelChoice {
  providerId: string
  modelId: string
  /** Null means the model's own default effort, which most models have. */
  reasoning: string | null
}

/**
 * The chosen models.
 *
 * Null means nobody has chosen yet. There is no configured fallback behind these on
 * purpose: a model named in two places, one of which quietly wins, makes "which
 * model answered this?" unanswerable.
 */
export interface AiPreferencesRecord {
  chat: AiModelChoice | null
  updatedAt: number
}

export interface AiPreferencesStore {
  get(): Promise<AiPreferencesRecord | null>
  put(preferences: { chat: AiModelChoice | null }): Promise<AiPreferencesRecord>
}
