import { expect, test } from "bun:test"
import { StyledText, TextAttributes, fg } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ChatTranscript, type ChatTranscriptBlock } from "./chat-transcript.ts"
import { DOUBLE_CLICK_MS } from "./selectable-list.ts"

/** A reply: plain text, signed underneath. */
function reply(text: string, signature = "gpt-5.6-sol"): ChatTranscriptBlock {
  return {
    id: `reply-${text}`,
    marker: new StyledText([fg("#888888")("•")]),
    content: new StyledText([fg("#dddddd")(text)]),
    footer: new StyledText([fg("#5a5a62")(`▪ ${signature}`)]),
  }
}

/** A question from the trader: filled, marked and padded. */
function asked(text: string): ChatTranscriptBlock {
  return {
    id: `asked-${text}`,
    marker: new StyledText([fg("#888888")("›")]),
    fill: "#1b1b22",
    padded: true,
    content: new StyledText([fg("#dddddd")(text)]),
  }
}

test("marks prompts with a chevron and replies with a bullet", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 14 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    asked("where is ASELS heading?"),
    reply("Higher, but watch the 320 level."),
  ])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("where is ASELS heading?")
  expect(frame).toContain("Higher, but watch the 320 level.")
  expect(frame).toContain("▪ gpt-5.6-sol")
  expect(frame).toContain("› where is ASELS heading?")
  expect(frame).toContain("• Higher, but watch the 320 level.")
  expect(frame).not.toContain("│")

  transcript.destroy()
  renderer.destroy()
})

test("a header sits above the words and a footer below them", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 12 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([{
    id: "thought",
    marker: new StyledText([fg("#888888")("•")]),
    header: new StyledText([fg("#c08a52")("+ thought")]),
    content: new StyledText([fg("#dddddd")("Volumes are thin.")]),
    footer: new StyledText([fg("#5a5a62")("▪ gpt-5.6-sol · 4.0s")]),
  }])
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const thought = lines.findIndex((line) => line.includes("+ thought"))
  const answer = lines.findIndex((line) => line.includes("Volumes are thin."))
  const signature = lines.findIndex((line) => line.includes("▪ gpt-5.6-sol · 4.0s"))
  expect(answer - thought).toBe(2)
  expect(signature - answer).toBe(2)

  transcript.destroy()
  renderer.destroy()
})

test("a turn with no spoken text puts its provenance directly under the thought", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 50, height: 10 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([{
    id: "tool-call",
    marker: new StyledText([fg("#888888")("•")]),
    header: new StyledText([fg("#c08a52")("Planning the alert")]),
    bodyVisible: false,
    content: new StyledText([]),
    footer: new StyledText([fg("#5a5a62")("▪ gpt-5.6-sol · 3.6s")]),
  }])
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const thought = lines.findIndex((line) => line.includes("Planning the alert"))
  const signature = lines.findIndex((line) => line.includes("▪ gpt-5.6-sol · 3.6s"))
  expect(signature - thought).toBe(1)

  transcript.destroy()
  renderer.destroy()
})

test("keeps a blank row between adjacent turns", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 14 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([reply("First answer."), reply("Second answer.")])
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const firstMeta = lines.findIndex((line) => line.includes("▪ gpt-5.6-sol"))
  const secondAnswer = lines.findIndex((line) => line.includes("Second answer."))
  expect(secondAnswer - firstMeta).toBe(2)

  transcript.destroy()
  renderer.destroy()
})

test("replaces what a turn says without rebuilding the conversation", async () => {
  // Deltas arrive many times a second: the last turn changes, the ones above it are
  // left alone.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 14 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([asked("and volumes?"), reply("Volumes")])
  const originalRows = transcript.root.getChildren()
  await renderOnce()

  transcript.setBlocks([asked("and volumes?"), reply("Volumes are thin.")])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("and volumes?")
  expect(frame).toContain("Volumes are thin.")

  transcript.setBlocks([asked("and volumes?"), reply("Volumes are thin."), reply("One more turn.")])
  expect(transcript.root.getChildren()[0]).toBe(originalRows[0])
  expect(transcript.root.getChildren()[1]).toBe(originalRows[1])

  // Removing a turn releases only that row; earlier native text views survive.
  transcript.setBlocks([asked("and volumes?")])
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Volumes are thin.")
  expect(transcript.root.getChildren()[0]).toBe(originalRows[0])
  expect(originalRows[1]?.isDestroyed).toBe(true)

  transcript.destroy()
  renderer.destroy()
})

test("keeps the newest turn in view as a reply streams in", async () => {
  // The tail is where the answer is being written, so a conversation longer than the
  // window shows its end rather than its beginning.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 8 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  const many = Array.from({ length: 12 }, (_, index) => reply(`answer ${index}`))
  transcript.setBlocks(many)
  await renderOnce()

  transcript.setBlocks([...many, reply("the latest word")])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("the latest word")
  expect(frame).not.toContain("answer 0")

  transcript.destroy()
  renderer.destroy()
})

test("reports when scrolling leaves the bottom and can jump back", async () => {
  const { renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 40, height: 8 })
  const bottomStates: boolean[] = []
  const transcript = new ChatTranscript(renderer, {
    backgroundColor: "#101010",
    onBottomChange: (atBottom) => bottomStates.push(atBottom),
  })
  renderer.root.add(transcript.root)
  transcript.setBlocks(Array.from({ length: 12 }, (_, index) => reply(`answer ${index}`)))
  await renderOnce()

  await mockMouse.scroll(10, 4, "up")
  await renderOnce()
  expect(bottomStates.at(-1)).toBe(false)

  transcript.scrollToBottom()
  await renderOnce()
  expect(bottomStates.at(-1)).toBe(true)

  const slider = transcript.root.verticalScrollBar.slider
  await mockMouse.click(slider.screenX, slider.screenY)
  await renderOnce()
  expect(bottomStates.at(-1)).toBe(false)

  transcript.destroy()
  renderer.destroy()
})

test("a note carries neither header nor footer, so an empty state does not look like someone spoke", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 8 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    {
      id: "note",
      content: new StyledText([fg("#888888")("No chat yet.")]),
    },
  ])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("No chat yet.")
  // The first line of the block is the note itself, not a blank where a name would be.
  const lines = frame.split("\n").filter((line) => line.trim().length > 0)
  expect(lines[0]).toContain("No chat yet.")

  transcript.destroy()
  renderer.destroy()
})

test("opens active contracts from full symbols and underlying tickers in wrapped chat text", async () => {
  const { renderer, mockMouse, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 38,
    height: 12,
  })
  const selected: string[] = []
  const transcript = new ChatTranscript(renderer, {
    backgroundColor: "#101010",
    resolveContractSymbol: (mention) => (
      mention === "F_SAHOL0826" || mention === "SAHOL" ? "F_SAHOL0826" : null
    ),
    onContractSelect: (symbol) => selected.push(symbol),
  })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    reply("Best setup for Monday: SAHOL long breakout. Contract F_SAHOL0826. Ignore BIST and F_OLD0826."),
  ])
  await renderOnce()

  const spans = captureSpans().lines.flatMap((line) => line.spans)
  const underlying = spans.find((span) => span.text === "SAHOL")
  const contract = spans.find((span) => span.text === "F_SAHOL0826")
  expect((underlying?.attributes ?? 0) & TextAttributes.UNDERLINE).not.toBe(0)
  expect((contract?.attributes ?? 0) & TextAttributes.UNDERLINE).not.toBe(0)
  expect(spans.find((span) => span.text.includes("BIST"))?.attributes ?? 0)
    .toBe(0)
  expect(spans.find((span) => span.text.includes("F_OLD0826"))?.attributes ?? 0)
    .toBe(0)

  const lines = captureCharFrame().split("\n")
  const underlyingY = lines.findIndex((line) => line.includes("SAHOL"))
  const underlyingX = lines[underlyingY]?.indexOf("SAHOL") ?? -1
  await mockMouse.click(underlyingX + 2, underlyingY)
  expect(selected).toEqual(["F_SAHOL0826"])

  const contractY = lines.findIndex((line) => line.includes("F_SAHOL0826"))
  const contractX = lines[contractY]?.indexOf("F_SAHOL0826") ?? -1
  await mockMouse.click(contractX + 2, contractY)
  expect(selected).toEqual(["F_SAHOL0826", "F_SAHOL0826"])

  const unknownY = lines.findIndex((line) => line.includes("F_OLD0826"))
  const unknownX = lines[unknownY]?.indexOf("F_OLD0826") ?? -1
  await mockMouse.click(unknownX + 2, unknownY)
  expect(selected).toEqual(["F_SAHOL0826", "F_SAHOL0826"])

  transcript.destroy()
  renderer.destroy()
})

test("selects a clickable prompt while preserving contract-link priority", async () => {
  const { renderer, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({ width: 50, height: 8 })
  const contracts: string[] = []
  const blocks: string[] = []
  const transcript = new ChatTranscript(renderer, {
    backgroundColor: "#101010",
    resolveContractSymbol: (mention) => mention === "ASELS" ? "F_ASELS0826" : null,
    onContractSelect: (symbol) => contracts.push(symbol),
    onBlockSelect: (id) => blocks.push(id),
  })
  renderer.root.add(transcript.root)
  transcript.setBlocks([{ ...asked("revisit ASELS after earnings"), selectable: true }])
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const promptY = lines.findIndex((line) => line.includes("revisit ASELS"))
  const contractX = lines[promptY]?.indexOf("ASELS") ?? -1
  await mockMouse.click(contractX + 2, promptY)
  expect(contracts).toEqual(["F_ASELS0826"])
  expect(blocks).toEqual([])

  const promptX = lines[promptY]?.indexOf("revisit") ?? -1
  await mockMouse.click(promptX + 2, promptY)
  expect(blocks).toEqual(["asked-revisit ASELS after earnings"])

  transcript.destroy()
  renderer.destroy()
})

test("does not treat clicks on different rows as a double-click", async () => {
  const { renderer, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({ width: 50, height: 10 })
  const blocks: string[] = []
  let doubleClicks = 0
  const transcript = new ChatTranscript(renderer, {
    backgroundColor: "#101010",
    canDoubleClick: () => true,
    onBlockSelect: (id) => blocks.push(id),
    onDoubleClick: () => { doubleClicks += 1 },
  })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    { ...asked("first prompt"), selectable: true },
    { ...asked("second prompt"), selectable: true },
  ])
  await renderOnce()

  const lines = captureCharFrame().split("\n")
  const firstY = lines.findIndex((line) => line.includes("first prompt"))
  const secondY = lines.findIndex((line) => line.includes("second prompt"))
  await mockMouse.click((lines[firstY]?.indexOf("first") ?? -1) + 2, firstY)
  await mockMouse.click((lines[secondY]?.indexOf("second") ?? -1) + 2, secondY)
  await Bun.sleep(DOUBLE_CLICK_MS + 10)

  expect(doubleClicks).toBe(0)
  expect(blocks).toEqual(["asked-first prompt", "asked-second prompt"])

  transcript.destroy()
  renderer.destroy()
})
