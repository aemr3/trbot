import { expect, test } from "bun:test"
import { StyledText, fg } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ChatTranscript, type ChatTranscriptBlock } from "./chat-transcript.ts"

function block(name: string, text: string, overrides: Partial<ChatTranscriptBlock> = {}): ChatTranscriptBlock {
  return {
    id: `${name}-${text}`,
    name,
    nameColor: "#dddddd",
    railColor: "#7c83ff",
    content: new StyledText([fg("#dddddd")(text)]),
    ...overrides,
  }
}

test("rails each turn against the name of whoever said it", async () => {
  // A reply that wraps over many lines is still visibly one reply, which is the whole
  // point of the rail.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 12 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    block("you", "where is ASELS heading?"),
    block("gpt-5.6-sol", "Higher, but watch the 320 level."),
  ])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("you")
  expect(frame).toContain("where is ASELS heading?")
  expect(frame).toContain("gpt-5.6-sol")
  // The rail runs down the left of every line the turn occupies.
  const railed = frame.split("\n").filter((line) => line.includes("│"))
  expect(railed.length).toBeGreaterThanOrEqual(4)

  transcript.destroy()
  renderer.destroy()
})

test("replaces what a turn says without rebuilding the conversation", async () => {
  // Deltas arrive many times a second: the last turn changes, the ones above it are
  // left alone.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 12 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([block("you", "and volumes?"), block("model", "Volumes")])
  await renderOnce()

  transcript.setBlocks([block("you", "and volumes?"), block("model", "Volumes are thin.")])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("and volumes?")
  expect(frame).toContain("Volumes are thin.")

  // A turn arriving, or one going, reshapes the list rather than editing it.
  transcript.setBlocks([block("you", "and volumes?")])
  await renderOnce()
  expect(captureCharFrame()).not.toContain("Volumes are thin.")

  transcript.destroy()
  renderer.destroy()
})

test("keeps the newest turn in view as a reply streams in", async () => {
  // The tail is where the answer is being written, so a conversation longer than the
  // window shows its end rather than its beginning.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 8 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  const many = Array.from({ length: 12 }, (_, index) => block("you", `question ${index}`))
  transcript.setBlocks(many)
  await renderOnce()

  transcript.setBlocks([...many, block("model", "the latest word")])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("the latest word")
  expect(frame).not.toContain("question 0")

  transcript.destroy()
  renderer.destroy()
})

test("a note carries no name, so an empty state does not look like someone spoke", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 8 })
  const transcript = new ChatTranscript(renderer, { backgroundColor: "#101010" })
  renderer.root.add(transcript.root)
  transcript.setBlocks([
    {
      id: "note",
      railColor: "#101010",
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
