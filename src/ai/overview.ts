import { streamText, type LanguageModel } from "ai"
import type { MarketOverviewDigest, OverviewMode } from "../market/overview.ts"

// Turns a deterministic market digest into short English commentary. The digest
// carries every number the model may cite; the model adds no arithmetic of its
// own, so a wrong figure here is a digest bug, not a hallucination to chase.

// What the watchlist screen depends on; the model-backed implementation below
// is wired in by the app so tests can substitute a recording fake.
export interface OverviewGenerateOptions {
  signal?: AbortSignal
  onDelta: (text: string) => void
}

export interface OverviewGenerator {
  generate(digest: MarketOverviewDigest, options: OverviewGenerateOptions): Promise<void>
}

const OVERVIEW_PROMPT_BASE = [
  "You are a market microstructure analyst writing a brief for the trader's own reading.",
  "You receive a JSON digest of one instrument, built from that instrument's brokerage-house data",
  "and its own price history.",
  "Every figure in the digest is measured on the underlying equity, named by instrument.symbol and",
  "priced by instrument.lastPrice. The trader deals the futures contract instead:",
  "instrument.contractSymbol at instrument.contractLastPrice, which sits instrument.basis above the",
  "underlying. Never compare the two prices as if they were one market.",
  "The brief renders in a narrow plain-text terminal panel: write in English, at most 120 words,",
  "no markdown, no headers — short paragraphs only.",
  "Do not narrate every section; surface only the few signals that matter right now, citing the",
  "digest's own numbers and naming the houses behind them.",
  "Close with exactly one trade idea on one line: direction, entry zone, invalidation level, and",
  "the single digest fact that carries it. Quote its levels on the contract, converting the",
  "underlying levels you read them from with the basis.",
  "Commit to the side the evidence favours — never pair a long and a short, and never hedge one",
  "idea with the other direction. When the digest genuinely supports neither side, write one line",
  "saying to stand aside and what would have to happen to make a trade.",
].join(" ")

const OVERVIEW_PROMPT_BY_MODE: Record<OverviewMode, string> = {
  INTRADAY: [
    "This is the intraday view: the live order book, the session's trade tape grouped by house,",
    "the range's trade-flow distribution with each house's volume-weighted average price, session",
    "candles, and a short daily tail for trend context.",
    "Read the session's structure from the intraday candles and anchor it to who is aggressing on",
    "the tape and how the resting book leans. The idea must be intraday: entry and",
    "invalidation at this session's levels.",
  ].join(" "),
  DAILY: [
    "This is the daily view: the range's trade-flow distribution with each house's volume-weighted",
    "average price, the settled custody register showing which houses' holdings grew or shrank, and",
    "the daily price history.",
    "The custody register settles after the session: treat it as positioning as of its lastUpdate,",
    "never as live activity. Call out where flow and custody diverge: heavy flow with a flat",
    "register is churn, custody growth with quiet flow is accumulation.",
    "The idea must be a swing idea on the daily timeframe, at levels from the daily candles.",
  ].join(" "),
}

export function overviewSystemPrompt(mode: OverviewMode): string {
  return `${OVERVIEW_PROMPT_BASE} ${OVERVIEW_PROMPT_BY_MODE[mode]}`
}

export function overviewPrompt(digest: MarketOverviewDigest): string {
  return [
    `Digest for ${digest.instrument.symbol}, traded as ${digest.instrument.contractSymbol}:`,
    JSON.stringify(digest),
    "Write the overview.",
  ].join("\n")
}

// Effort hint forwarded to the provider; the set of accepted values is the
// provider's own, so it stays an open string.
export interface ModelOverviewGeneratorOptions {
  reasoningEffort?: string
}

export class ModelOverviewGenerator implements OverviewGenerator {
  constructor(
    private readonly model: LanguageModel,
    private readonly options: ModelOverviewGeneratorOptions = {},
  ) {}

  async generate(digest: MarketOverviewDigest, options: OverviewGenerateOptions): Promise<void> {
    // Stream errors are reported through the callback rather than thrown from
    // the iterator, so they are captured and rethrown once the stream drains.
    let failure: unknown
    const result = streamText({
      model: this.model,
      system: overviewSystemPrompt(digest.mode),
      prompt: overviewPrompt(digest),
      abortSignal: options.signal,
      providerOptions: this.options.reasoningEffort
        ? { openai: { reasoningEffort: this.options.reasoningEffort } }
        : undefined,
      onError: ({ error }) => {
        failure = error
      },
    })
    for await (const delta of result.textStream) options.onDelta(delta)
    if (failure !== undefined) throw failure
  }
}
