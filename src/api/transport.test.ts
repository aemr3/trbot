import { expect, test } from "bun:test"
import { readSse, type SseFrame } from "./transport.ts"

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!))
      else controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of readSse(streamFrom(chunks))) frames.push(frame)
  return frames
}

test("parses named events with single-line data", async () => {
  const frames = await collect(['event: PriceUpdate\ndata: {"s":"F_AKBNK0825","p":68.68}\n\n'])
  expect(frames).toEqual([{ event: "PriceUpdate", data: '{"s":"F_AKBNK0825","p":68.68}' }])
})

test("joins multi-line data and defaults the event to null", async () => {
  const frames = await collect(["data: line1\ndata: line2\n\n"])
  expect(frames).toEqual([{ event: null, data: "line1\nline2" }])
})

test("normalizes CRLF line endings", async () => {
  const frames = await collect(["event: PriceUpdate\r\ndata: {}\r\n\r\n"])
  expect(frames).toEqual([{ event: "PriceUpdate", data: "{}" }])
})

test("ignores comment and keep-alive lines", async () => {
  const frames = await collect([": keep-alive\n\n", "data: real\n\n"])
  expect(frames).toEqual([{ event: null, data: "real" }])
})

test("reassembles frames split across chunks", async () => {
  const frames = await collect(["event: PriceUp", "date\ndata: {\"p\":", "1}\n\n"])
  expect(frames).toEqual([{ event: "PriceUpdate", data: '{"p":1}' }])
})

test("emits a trailing frame that has no closing blank line", async () => {
  const frames = await collect(["data: tail"])
  expect(frames).toEqual([{ event: null, data: "tail" }])
})
