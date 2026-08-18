import { ChatGptAccountService, type ChatGptCredentials, type ChatGptTokenRefresh } from "@trbot/ai/chatgpt-account.ts"
import { codexModel } from "@trbot/ai/codex-model.ts"
import { ModelOverviewGenerator } from "@trbot/ai/overview.ts"
import type { ProviderState, ProviderStateStore } from "@trbot/ai/provider-state.ts"
import type {
  MarketOverviewDigest,
  OverviewGenerateOptions,
  OverviewGenerator,
} from "@trbot/market/overview.ts"
import type { AiAccountSummary } from "@trbot/protocol/ai.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"

export interface AiServiceOptions {
  states: ProviderStateStore
  model: string
  reasoningEffort?: string
  tokens?: ChatGptTokenRefresh
  /** Overridden in tests; the real generator streams from ChatGPT. */
  generator?: OverviewGenerator
  now?: () => number
}

/**
 * Everything the server does with ChatGPT: holding the connection and generating
 * the market overview.
 *
 * The login itself is not here. The provider only redirects an authorization to a
 * loopback address, which is the trader's machine and not necessarily this one, so
 * the terminal runs the whole login and hands over what it produced — the same
 * direction, and the same trust, as the provider password it already sends. The
 * tokens are only ever stored and refreshed in this process, and nothing hands one
 * back out.
 */
export class AiService {
  private readonly account: ChatGptAccountService
  private readonly generator: OverviewGenerator

  constructor(options: AiServiceOptions) {
    this.account = new ChatGptAccountService(options.states, {
      ...(options.tokens ? { tokens: options.tokens } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    this.generator = options.generator
      ?? new ModelOverviewGenerator(codexModel(options.model), {
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        accessToken: () => this.accessToken(),
      })
  }

  async summary(): Promise<AiAccountSummary | null> {
    const state = await this.account.getState()
    return state ? summarize(state) : null
  }

  /** Takes on the connection a terminal's login produced. */
  async connect(credentials: ChatGptCredentials): Promise<AiAccountSummary> {
    return summarize(await this.account.save(credentials))
  }

  disconnect(): Promise<void> {
    return this.account.disconnect()
  }

  /**
   * The credential for a model call, refreshed if it is close to lapsing.
   *
   * Read per call rather than held: an access token lasts under an hour, so
   * anything that captured one would work until the first refresh and then stop.
   */
  async accessToken(): Promise<string> {
    return (await this.account.validState()).accessToken
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
}

function summarize(state: ProviderState): AiAccountSummary {
  return {
    providerId: state.providerId,
    accountId: state.accountId,
    connectedAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
