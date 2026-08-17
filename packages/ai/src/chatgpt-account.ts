import { openExternalUrl } from "./browser.ts"
import {
  ChatGptOAuthClient,
  chatGptIdentity,
  type ChatGptOAuth,
  type ChatGptOAuthLoginOptions,
} from "./chatgpt-oauth.ts"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

const REFRESH_MARGIN_MS = 60_000

export interface ChatGptAccount {
  getState(): Promise<ProviderState | null>
  connect(options?: Omit<ChatGptOAuthLoginOptions, "openUrl">): Promise<ProviderState>
  disconnect(): Promise<void>
}

interface ChatGptAccountServiceOptions {
  oauth?: ChatGptOAuth
  openUrl?: (url: string) => Promise<void>
  now?: () => number
}

export class ChatGptAccountService implements ChatGptAccount {
  private readonly oauth: ChatGptOAuth
  private readonly openUrl: (url: string) => Promise<void>
  private readonly now: () => number
  private refreshRequest: Promise<ProviderState> | null = null

  constructor(
    private readonly store: ProviderStateStore,
    options: ChatGptAccountServiceOptions = {},
  ) {
    this.oauth = options.oauth ?? new ChatGptOAuthClient()
    this.openUrl = options.openUrl ?? openExternalUrl
    this.now = options.now ?? Date.now
  }

  getState(): Promise<ProviderState | null> {
    return this.store.get(CHATGPT_PROVIDER_ID)
  }

  async connect(options: Omit<ChatGptOAuthLoginOptions, "openUrl"> = {}): Promise<ProviderState> {
    const tokens = await this.oauth.login({ ...options, openUrl: this.openUrl })
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
    await this.store.put(state)
    return state
  }

  disconnect(): Promise<void> {
    return this.store.delete(CHATGPT_PROVIDER_ID)
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
    await this.store.put(refreshed)
    return refreshed
  }
}
