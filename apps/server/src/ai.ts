import { ChatGptAccountService, type ChatGptCredentials } from "@trbot/ai/chatgpt-account.ts"
import { harnessModel, type AiHarness } from "@trbot/ai/harness.ts"
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
  /** The harness, which owns the catalogue and every credential decision. */
  models: AiHarness
  model: string
  reasoningEffort?: string
  /** Overridden in tests; the real generator streams from ChatGPT. */
  generator?: OverviewGenerator
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
    this.account = new ChatGptAccountService(options.states, options.models)
    this.generator = options.generator
      ?? new ModelOverviewGenerator(options.models, harnessModel(options.models, options.model), {
        reasoningEffort: options.reasoningEffort,
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
   * Fails before a response starts streaming when ChatGPT is not connected, so
   * the client sees an ordinary error rather than an empty overview.
   *
   * Only asks whether a connection exists. A token that has lapsed is not a
   * refusal: the harness refreshes it as part of the request.
   */
  async requireConnected(): Promise<void> {
    if (!(await this.account.isConnected())) {
      throw new ProtocolError("invalid_request", "ChatGPT is not connected")
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
