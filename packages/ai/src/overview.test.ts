import { expect, test } from "bun:test"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai"
import { buildOverviewDigest } from "@trbot/market/overview.ts"
import { ModelOverviewGenerator, overviewPrompt, overviewSystemPrompt } from "./overview.ts"

const DIGEST = buildOverviewDigest({
  mode: "INTRADAY",
  instrument: { symbol: "ASELS", displayName: null, lastPrice: 390, contractSymbol: "F_ASELS0826", contractLastPrice: 394 },
  buyerFlow: {
    side: "BUYER",
    shares: [{
      brokerage: "Alpha",
      netLots: 500,
      averagePrice: 388,
      percentage: 25,
      grossLots: 1_500,
      volumeShare: 8,
    }],
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

test("prompt hands the model the digest verbatim", () => {
  const prompt = overviewPrompt(DIGEST)
  expect(prompt).toContain("ASELS")
  expect(prompt).toContain(JSON.stringify(DIGEST))
})

test("each horizon gets its own commentary contract", () => {
  const intraday = overviewSystemPrompt("INTRADAY")
  expect(intraday).toContain("exactly one trade idea")
  expect(intraday).toContain("intraday view")
  expect(intraday).not.toContain("custody register")

  const daily = overviewSystemPrompt("DAILY")
  expect(daily).toContain("exactly one trade idea")
  expect(daily).toContain("custody register")
  expect(daily).toContain("lastUpdate")
  expect(daily).toContain("swing idea")
})

test("the idea has to say where to get out, both ways", () => {
  // Entry and invalidation without a target leaves the winning side of the
  // trade unmanaged, which is the half a stop manager cannot help with.
  for (const mode of ["INTRADAY", "DAILY"] as const) {
    const prompt = overviewSystemPrompt(mode)
    expect(prompt).toContain("take profit")
    expect(prompt).toContain("Name both exits")
  }
})

test("the brief commits to a side instead of listing both", () => {
  // A long paired with a short is not a reading, it is two readings; the brief
  // has to pick, or say to stand aside.
  for (const mode of ["INTRADAY", "DAILY"] as const) {
    const prompt = overviewSystemPrompt(mode)
    expect(prompt).toContain("never pair a long and a short")
    expect(prompt).toContain("stand aside")
  }
})

/** A harness answering with scripted replies, as the harness's own tests do it. */
function scripted(options: { reasoning?: boolean } = {}) {
  const faux = fauxProvider({ models: [{ id: "overview-model", ...options }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models }
}

test("streams the model's words through onDelta and leaves its reasoning out", async () => {
  // The trader reads the brief, not the working. A reasoning model emits both, so
  // the generator has to forward one and drop the other.
  const { faux, models } = scripted({ reasoning: true })
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("weighing the tape"), fauxText("Bid side dominates.")]),
  ])
  const generator = new ModelOverviewGenerator(models, faux.getModel(), { reasoningEffort: "high" })

  const deltas: string[] = []
  await generator.generate(DIGEST, { onDelta: (text) => deltas.push(text) })

  expect(deltas.join("")).toBe("Bid side dominates.")
})

test("generates again from the same instance", async () => {
  // One generator serves every overview for as long as the server runs, so a
  // second call has to behave like the first. What used to be checked here — that
  // a credential is read per call rather than captured — is the harness's own
  // business now: it resolves and refreshes one per request.
  const { faux, models } = scripted()
  faux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")])
  const generator = new ModelOverviewGenerator(models, faux.getModel())

  const deltas: string[] = []
  await generator.generate(DIGEST, { onDelta: (text) => deltas.push(text) })
  await generator.generate(DIGEST, { onDelta: (text) => deltas.push(text) })

  expect(deltas).toEqual(["First.", "Second."])
})

test("rethrows a stream failure instead of finishing silently", async () => {
  // The harness reports a failure as the stream's final message rather than by
  // throwing, so an unread one becomes an empty overview and no error at all.
  const { faux, models } = scripted()
  faux.setResponses([
    fauxAssistantMessage([fauxText("Partial")], { stopReason: "error", errorMessage: "stream lost" }),
  ])
  const generator = new ModelOverviewGenerator(models, faux.getModel())

  expect(generator.generate(DIGEST, { onDelta: () => {} })).rejects.toThrow("stream lost")
})
