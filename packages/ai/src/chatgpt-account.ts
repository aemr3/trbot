import { chatGptIdentity, ChatGptOAuthClient, type ChatGptOAuth, type ChatGptTokenResponse } from "./chatgpt-oauth.ts"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

const REFRESH_MARGIN_MS = 60_000

interface ChatGptAccountServiceOptions {
  oauth?: ChatGptOAuth
  now?: () => number
}

/**
 * Owns the stored ChatGPT tokens and keeps them fresh.
 *
 * This runs on the server only. A client learns which account is connected
 * through the protocol summary; the tokens themselves never leave the process
 * that talks to ChatGPT.
 */
export class ChatGptAccountService {
  private readonly oauth: ChatGptOAuth
  private readonly now: () => number
  private refreshRequest: Promise<ProviderState> | null = null

  constructor(
    private readonly states: ProviderStateStore,
    options: ChatGptAccountServiceOptions = {},
  ) {
    this.oauth = options.oauth ?? new ChatGptOAuthClient()
    this.now = options.now ?? Date.now
  }

  getState(): Promise<ProviderState | null> {
    return this.states.get(CHATGPT_PROVIDER_ID)
  }

  /** Records the tokens a finished authorization produced. */
  async save(tokens: ChatGptTokenResponse): Promise<ProviderState> {
    const identity = chatGptIdentity(tokens)
    const previous = await this.getState()
    const now = this.now()
    const state: ProviderState = {
      providerId: CHATGPT_PROVIDER_ID,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now + tokens.expiresIn * 1_000,
      accountId: identity.accountId,
      email: identity.email,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    await this.states.put(state)
    return state
  }

  disconnect(): Promise<void> {
    return this.states.delete(CHATGPT_PROVIDER_ID)
  }

  async validState(): Promise<ProviderState> {
    const state = await this.getState()
    if (!state) throw new Error("ChatGPT is not connected")
    if (state.expiresAt > this.now() + REFRESH_MARGIN_MS) return state
    if (!this.refreshRequest) {
      this.refreshRequest = this.refresh(state).finally(() => {
        this.refreshRequest = null
      })
    }
    return this.refreshRequest
  }

  private async refresh(state: ProviderState): Promise<ProviderState> {
    const tokens = await this.oauth.refresh(state.refreshToken)
    const identity = chatGptIdentity(tokens)
    const now = this.now()
    const refreshed: ProviderState = {
      ...state,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now + tokens.expiresIn * 1_000,
      accountId: identity.accountId ?? state.accountId,
      email: identity.email ?? state.email,
      updatedAt: now,
    }
    await this.states.put(refreshed)
    return refreshed
  }
}
