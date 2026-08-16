import { expect, test } from "bun:test"
import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { buildOverviewDigest } from "../market/overview.ts"
import { ModelOverviewGenerator, overviewPrompt, overviewSystemPrompt } from "./overview.ts"

const DIGEST = buildOverviewDigest({
  mode: "INTRADAY",
  instrument: { symbol: "ASELS", displayName: null, lastPrice: 390 },
  buyerFlow: {
    side: "BUYER",
    shares: [{ brokerage: "Alpha", netLots: 500, averagePrice: 388, percentage: 25 }],
    topCount: 1,
    topPercentage: 25,
    topLots: 500,
    otherLots: 1500,
    lastUpdate: "14:30",
    live: true,
    presets: [],
    availableDates: [],
  },
  range: { start: null, end: null },
})

const NO_TOKENS = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

function streamOf(parts: LanguageModelV3StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) }
}

test("prompt hands the model the digest verbatim", () => {
  const prompt = overviewPrompt(DIGEST)
  expect(prompt).toContain("ASELS")
  expect(prompt).toContain(JSON.stringify(DIGEST))
})

test("each horizon gets its own commentary contract", () => {
  const intraday = overviewSystemPrompt("INTRADAY")
  expect(intraday).toContain("trade ideas")
  expect(intraday).toContain("intraday view")
  expect(intraday).not.toContain("custody register")

  const daily = overviewSystemPrompt("DAILY")
  expect(daily).toContain("trade ideas")
  expect(daily).toContain("custody register")
  expect(daily).toContain("lastUpdate")
  expect(daily).toContain("swing ideas")
})

test("streams deltas through onDelta and forwards the reasoning effort", async () => {
  const model = new MockLanguageModelV3({
    doStream: streamOf([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Bid side " },
      { type: "text-delta", id: "1", delta: "dominates." },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: NO_TOKENS },
    ]),
  })
  const generator = new ModelOverviewGenerator(model, { reasoningEffort: "high" })

  const deltas: string[] = []
  await generator.generate(DIGEST, { onDelta: (text) => deltas.push(text) })

  expect(deltas.join("")).toBe("Bid side dominates.")
  expect(model.doStreamCalls[0]?.providerOptions).toEqual({ openai: { reasoningEffort: "high" } })
})

test("rethrows a stream error instead of finishing silently", async () => {
  const model = new MockLanguageModelV3({
    doStream: streamOf([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Partial" },
      { type: "error", error: new Error("stream lost") },
    ]),
  })
  const generator = new ModelOverviewGenerator(model)

  expect(generator.generate(DIGEST, { onDelta: () => {} })).rejects.toThrow("stream lost")
})
