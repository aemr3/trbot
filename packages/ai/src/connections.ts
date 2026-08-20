import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import type {
  AiAuthType,
  AiModelSummary,
  AiPreferences,
  AiProviderSummary,
} from "@trbot/protocol/ai.ts"
import type { AiCredentialStore, AiPreferencesStore } from "./credential-store.ts"
import { asCredential, CredentialInputSchema, StoredCredentials } from "./credentials.ts"
import type { AiHarness } from "./harness.ts"
import { z } from "zod"

const CredentialAccountSchema = z.object({ accountId: z.string().min(1).optional() })

/**
 * The model providers a trader has, and which model answers.
 *
 * Deliberately thin, and deliberately not about any one provider. Keeping a
 * credential usable is the harness's work; knowing which providers exist and which
 * models they offer is the harness's too. What is left here is what it has no opinion
 * about: where a credential lives, when it was connected, and which of its 1200-odd
 * models this trader chose for the two places trbot asks for one.
 */
export class AiConnections {
  private readonly credentials: StoredCredentials

  constructor(
    private readonly harness: AiHarness,
    private readonly store: AiCredentialStore,
    private readonly preferencesStore: AiPreferencesStore,
  ) {
    this.credentials = new StoredCredentials(store)
  }

  /** Every provider the harness ships with, connected or not. */
  async providers(): Promise<AiProviderSummary[]> {
    const records = new Map((await this.store.list()).map((record) => [record.providerId, record]))
    const summaries: AiProviderSummary[] = []

    for (const provider of this.harness.getProviders()) {
      const record = records.get(provider.id) ?? null
      // Asks the harness rather than reading the row: a provider can also be
      // configured by an ambient environment variable, with nothing stored at all.
      const check = await this.harness.checkAuth(provider.id)
      const authTypes: AiAuthType[] = []
      if (provider.auth.oauth) authTypes.push("oauth")
      if (provider.auth.apiKey) authTypes.push("api_key")

      summaries.push({
        providerId: provider.id,
        name: provider.name,
        authTypes,
        isSubscription: provider.auth.oauth?.isSubscription === true,
        connected: check !== undefined,
        source: check?.source ?? null,
        accountId: record ? accountIdOf(record.credential) : null,
        connectedAt: record?.createdAt ?? null,
        updatedAt: record?.updatedAt ?? null,
      })
    }
    return summaries.sort(byConnectedThenName)
  }

  /** Records what a login produced, and picks up a dynamic catalogue if there is one. */
  async connect(
    providerId: string,
    credential: z.input<typeof CredentialInputSchema>,
  ): Promise<AiProviderSummary> {
    const valid = asCredential(credential)
    if (!valid) throw new Error("That is not a credential this harness recognises")
    if (!this.harness.getProvider(providerId)) throw new Error(`No provider named "${providerId}"`)

    await this.credentials.modify(providerId, async () => valid)
    // Providers whose catalogue is fetched rather than bundled have no models until
    // this runs. Best effort: a failure here costs a model list, not a connection.
    await this.harness.refresh({ providers: [providerId] }).catch(() => undefined)

    const summary = (await this.providers()).find((provider) => provider.providerId === providerId)
    if (!summary) throw new Error(`No provider named "${providerId}"`)
    return summary
  }

  disconnect(providerId: string): Promise<void> {
    return this.harness.logout(providerId)
  }

  isConnected(providerId: string): Promise<boolean> {
    // Undefined is the harness's way of saying "not configured".
    return this.harness.checkAuth(providerId).then((check) => check !== undefined)
  }

  /**
   * Every model a trader can use right now.
   *
   * The harness filters by whether each provider's auth is complete, so a picker
   * built from this cannot offer a model that would fail on send.
   */
  async models(): Promise<AiModelSummary[]> {
    const available = await this.harness.getAvailable()
    return available
      .map((model) => ({
        providerId: model.provider,
        providerName: this.harness.getProvider(model.provider)?.name ?? model.provider,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevels: [...getSupportedThinkingLevels(model)],
        contextWindow: model.contextWindow,
      }))
      .sort((left, right) =>
        left.providerName === right.providerName
          ? left.name.localeCompare(right.name)
          : left.providerName.localeCompare(right.providerName),
      )
  }

  async preferences(): Promise<AiPreferences> {
    const stored = await this.preferencesStore.get()
    return { overview: stored?.overview ?? null, chat: stored?.chat ?? null }
  }

  async setPreferences(preferences: AiPreferences): Promise<AiPreferences> {
    const saved = await this.preferencesStore.put(preferences)
    return { overview: saved.overview, chat: saved.chat }
  }
}

function accountIdOf(credential: z.input<typeof CredentialInputSchema>): string | null {
  const valid = asCredential(credential)
  const parsed = CredentialAccountSchema.safeParse(valid)
  return parsed.success ? parsed.data.accountId ?? null : null
}

/** Connected providers first, so a trader's own list is at the top. */
function byConnectedThenName(left: AiProviderSummary, right: AiProviderSummary): number {
  if (left.connected !== right.connected) return left.connected ? -1 : 1
  return left.name.localeCompare(right.name)
}
