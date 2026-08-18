import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

const REFRESH_MARGIN_MS = 60_000

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

/** Exchanging a refresh token for a new access token. Replaced in tests. */
export interface ChatGptTokenRefresh {
  refresh(refreshToken: string): Promise<ChatGptCredentials>
}

export const chatGptTokenRefresh: ChatGptTokenRefresh = {
  async refresh(refreshToken) {
    const credentials = await refreshOpenAICodexToken(refreshToken)
    return {
      accessToken: credentials.access,
      refreshToken: credentials.refresh,
      expiresAt: credentials.expires,
      accountId: typeof credentials.accountId === "string" ? credentials.accountId : null,
    }
  },
}

interface ChatGptAccountServiceOptions {
  tokens?: ChatGptTokenRefresh
  now?: () => number
}

/**
 * Owns the stored ChatGPT tokens and keeps them fresh.
 *
 * This runs on the server only. A client hands over the credentials a login
 * produced and afterwards learns only which account is connected; refreshing
 * happens here, unattended, for as long as the server runs.
 */
export class ChatGptAccountService {
  private readonly tokens: ChatGptTokenRefresh
  private readonly now: () => number
  private refreshRequest: Promise<ProviderState> | null = null

  constructor(
    private readonly states: ProviderStateStore,
    options: ChatGptAccountServiceOptions = {},
  ) {
    this.tokens = options.tokens ?? chatGptTokenRefresh
    this.now = options.now ?? Date.now
  }

  getState(): Promise<ProviderState | null> {
    return this.states.get(CHATGPT_PROVIDER_ID)
  }

  /** Records the credentials a finished login produced. */
  async save(credentials: ChatGptCredentials): Promise<ProviderState> {
    const previous = await this.getState()
    const now = this.now()
    const state: ProviderState = {
      providerId: CHATGPT_PROVIDER_ID,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      accountId: credentials.accountId,
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
    const credentials = await this.tokens.refresh(state.refreshToken)
    const refreshed: ProviderState = {
      ...state,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      accountId: credentials.accountId ?? state.accountId,
      updatedAt: this.now(),
    }
    await this.states.put(refreshed)
    return refreshed
  }
}
