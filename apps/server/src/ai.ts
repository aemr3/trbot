import { AiConnections } from "@trbot/ai/connections.ts"
import type { AiHarness } from "@trbot/ai/harness.ts"
import type { AiCredentialStore, AiPreferencesStore } from "@trbot/ai/credential-store.ts"
import type {
  AiCredentials,
  AiModelSummary,
  AiPreferences,
  AiProviderSummary,
} from "@trbot/protocol/ai.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"

export interface AiServiceOptions {
  /** The harness, which owns the catalogue and every credential decision. */
  models: AiHarness
  credentials: AiCredentialStore
  preferences: AiPreferencesStore
}

/**
 * Everything the server does with model providers: holding their credentials, saying
 * which models are usable, and remembering the default for new chats.
 *
 * No provider is special here. A login is not here either: a provider only redirects
 * an authorization to a loopback address, which is the trader's machine and not
 * necessarily this one, and an API key is typed by the trader, so the terminal runs
 * the whole login and hands over what it produced — the same direction, and the same
 * trust, as the provider password it already sends. Credentials are only ever stored
 * and refreshed in this process, and nothing hands one back out.
 */
export class AiService {
  private readonly connections: AiConnections

  constructor(private readonly options: AiServiceOptions) {
    this.connections = new AiConnections(options.models, options.credentials, options.preferences)
  }

  providers(): Promise<AiProviderSummary[]> {
    return this.connections.providers()
  }

  models(): Promise<AiModelSummary[]> {
    return this.connections.models()
  }

  /** Takes on the credential a terminal's login produced. */
  connect(credentials: AiCredentials): Promise<AiProviderSummary> {
    return this.connections.connect(credentials.providerId, credentials.credential)
  }

  disconnect(providerId: string): Promise<void> {
    return this.connections.disconnect(providerId)
  }

  preferences(): Promise<AiPreferences> {
    return this.connections.preferences()
  }

  setPreferences(preferences: AiPreferences): Promise<AiPreferences> {
    return this.connections.setPreferences(preferences)
  }

  /**
   * The chat default, for a session that names no model of its own.
   *
   * Null rather than a guess: with nothing chosen there is no model to fall back to,
   * and inventing one would answer a trader's question from a model they never picked.
   */
  async chatDefault(): Promise<AiPreferences["chat"]> {
    return (await this.connections.preferences()).chat
  }

  /**
   * Fails before a chat starts when the model cannot be reached.
   *
   * Two separate refusals, because they have different fixes: nothing chosen, and a
   * provider whose credential has gone. A credential that has merely lapsed is
   * neither — the harness refreshes it as part of the request.
   */
  async requireModel(providerId?: string, modelId?: string): Promise<void> {
    if (!providerId || !modelId) {
      throw new ProtocolError("invalid_request", "No model chosen for this chat session")
    }
    if (!(await this.connections.isConnected(providerId))) {
      const name = this.options.models.getProvider(providerId)?.name ?? providerId
      throw new ProtocolError("invalid_request", `${name} is not connected`)
    }
  }

}
