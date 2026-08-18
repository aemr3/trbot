import { ChatGptAccountService } from "@trbot/ai/chatgpt-account.ts"
import { ChatGptOAuthClient, chatGptRedirectUri, type ChatGptOAuth } from "@trbot/ai/chatgpt-oauth.ts"
import { createChatGptModel } from "@trbot/ai/chatgpt-provider.ts"
import { ModelOverviewGenerator } from "@trbot/ai/overview.ts"
import type { ProviderState, ProviderStateStore } from "@trbot/ai/provider-state.ts"
import type {
  MarketOverviewDigest,
  OverviewGenerateOptions,
  OverviewGenerator,
} from "@trbot/market/overview.ts"
import type { AiAccountSummary, AiLoginCallback, AiLoginStart } from "@trbot/protocol/ai.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"

/** How long a started authorization waits for the trader to finish it. */
const LOGIN_TTL_MS = 5 * 60 * 1_000

interface PendingLogin {
  verifier: string
  state: string
  redirectUri: string
  expiresAt: number
}

export interface AiServiceOptions {
  states: ProviderStateStore
  model: string
  reasoningEffort?: string
  oauth?: ChatGptOAuth
  /** Overridden in tests; the real generator streams from ChatGPT. */
  generator?: OverviewGenerator
  now?: () => number
}

/**
 * Everything the server does with ChatGPT: holding the connection, running the
 * login, and generating the market overview.
 *
 * The login is split because the provider only redirects to a loopback address.
 * The server builds the authorization URL and keeps the PKCE verifier; the
 * client opens the browser and catches the redirect; the code comes back here
 * to be exchanged. The tokens are only ever written and read in this process.
 */
export class AiService {
  private readonly account: ChatGptAccountService
  private readonly oauth: ChatGptOAuth
  private readonly generator: OverviewGenerator
  private readonly now: () => number
  private readonly pending = new Map<string, PendingLogin>()

  constructor(options: AiServiceOptions) {
    this.now = options.now ?? Date.now
    this.oauth = options.oauth ?? new ChatGptOAuthClient()
    this.account = new ChatGptAccountService(options.states, { oauth: this.oauth, now: this.now })
    this.generator = options.generator
      ?? new ModelOverviewGenerator(createChatGptModel(this.account, options.model), {
        reasoningEffort: options.reasoningEffort,
      })
  }

  async summary(): Promise<AiAccountSummary | null> {
    const state = await this.account.getState()
    return state ? summarize(state) : null
  }

  async beginLogin(): Promise<AiLoginStart> {
    this.sweep()
    const redirectUri = chatGptRedirectUri()
    const authorization = await this.oauth.authorize(redirectUri)
    const loginId = crypto.randomUUID()
    const expiresAt = this.now() + LOGIN_TTL_MS
    this.pending.set(loginId, {
      verifier: authorization.verifier,
      state: authorization.state,
      redirectUri,
      expiresAt,
    })
    return { loginId, authorizationUrl: authorization.authorizationUrl, redirectUri, expiresAt }
  }

  async completeLogin(callback: AiLoginCallback): Promise<AiAccountSummary> {
    this.sweep()
    const login = this.pending.get(callback.loginId)
    // Consumed either way: an authorization code is single-use, so a failed
    // exchange must not leave the verifier available for a second attempt.
    this.pending.delete(callback.loginId)
    if (!login) throw new ProtocolError("not_found", "That ChatGPT login has expired; start it again")
    if (login.state !== callback.state) {
      throw new ProtocolError("invalid_request", "The authorization state did not match")
    }
    const tokens = await this.oauth.exchange(callback.code, login.redirectUri, login.verifier)
    return summarize(await this.account.save(tokens))
  }

  disconnect(): Promise<void> {
    return this.account.disconnect()
  }

  /**
   * Fails before a response starts streaming when ChatGPT is not connected, so
   * the client sees an ordinary error rather than an empty overview.
   */
  async requireConnected(): Promise<void> {
    try {
      await this.account.validState()
    } catch (error) {
      throw new ProtocolError("invalid_request", errorMessage(error), { cause: error })
    }
  }

  generate(digest: MarketOverviewDigest, options: OverviewGenerateOptions): Promise<void> {
    return this.generator.generate(digest, options)
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(id)
    }
  }
}

function summarize(state: ProviderState): AiAccountSummary {
  return {
    providerId: state.providerId,
    email: state.email,
    accountId: state.accountId,
    connectedAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
