import type { Models } from "@earendil-works/pi-ai"
import { StoredCredentials } from "./credentials.ts"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

/**
 * What a finished ChatGPT login produces, in the harness's own shape.
 *
 * The login itself runs on the trader's machine — the provider only redirects to
 * a loopback address — so these arrive over the wire and are stored here. The
 * account id is read out of the access token by the harness; nothing in trbot
 * parses a token.
 */
export interface ChatGptCredentials {
  accessToken: string
  refreshToken: string
  /** Absolute expiry, as the harness reports it. */
  expiresAt: number
  accountId: string | null
}

/**
 * The stored ChatGPT connection.
 *
 * Deliberately thin. Keeping a token usable — knowing when it is close to
 * expiring, exchanging the refresh token, not letting two requests refresh at
 * once — is the harness's work, done against `StoredCredentials`. What is left
 * here is what the harness has no opinion about: recording the connection a login
 * produced, reporting which account it is, and forgetting it on request.
 */
export class ChatGptAccountService {
  private readonly credentials: StoredCredentials

  constructor(
    private readonly states: ProviderStateStore,
    private readonly models: Models,
  ) {
    this.credentials = new StoredCredentials(states)
  }

  getState(): Promise<ProviderState | null> {
    return this.states.get(CHATGPT_PROVIDER_ID)
  }

  /** Records the credentials a finished login produced. */
  async save(credentials: ChatGptCredentials): Promise<ProviderState> {
    await this.credentials.modify(CHATGPT_PROVIDER_ID, async () => ({
      type: "oauth",
      access: credentials.accessToken,
      refresh: credentials.refreshToken,
      expires: credentials.expiresAt,
      ...(credentials.accountId === null ? {} : { accountId: credentials.accountId }),
    }))
    const state = await this.getState()
    if (!state) throw new Error("The ChatGPT connection was not stored")
    return state
  }

  disconnect(): Promise<void> {
    return this.models.logout(CHATGPT_PROVIDER_ID)
  }

  /**
   * Whether the connection is complete enough to make a request with.
   *
   * Asks the harness rather than reading an expiry here: it is the thing that will
   * refresh the token, so it is the thing that knows whether it can.
   */
  async isConnected(): Promise<boolean> {
    // Undefined is the harness's way of saying "not configured".
    return (await this.models.checkAuth(CHATGPT_PROVIDER_ID)) !== undefined
  }
}
