import { expect, test } from "bun:test"
import { z } from "zod"
import { FetchTransport, isTransientStreamError, readSse, StreamHttpError, type SseFrame } from "./transport.ts"

const ReceivedRequestSchema = z.object({
  headers: z.record(z.string(), z.string()),
  body: z.string(),
})

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

test("classifies retryable stream disconnects without hiding other failures", () => {
  expect(isTransientStreamError(new StreamHttpError(504))).toBe(true)
  expect(isTransientStreamError(new Error("The socket connection was closed unexpectedly. For more information"))).toBe(true)
  expect(isTransientStreamError(new Error("Invalid stream payload"))).toBe(false)
  expect(isTransientStreamError(new StreamHttpError(401))).toBe(false)
})

test("sends HTTP requests with the iOS profile and preserves application headers", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      return Response.json({
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      }, {
        status: 429,
        headers: { "retry-after": "2" },
      })
    },
  })

  try {
    const response = await new FetchTransport().request({
      url: `http://127.0.0.1:${server.port}/graphql`,
      headers: {
        "content-type": "application/json",
        "user-agent": "Midas/iOS-test",
        "x-midas-app-id": "main",
      },
      body: JSON.stringify({ operationName: "Test" }),
    })
    const received = ReceivedRequestSchema.parse(JSON.parse(response.body))

    expect(response.status).toBe(429)
    expect(response.retryAfterMs).toBe(2_000)
    expect(received.body).toBe(JSON.stringify({ operationName: "Test" }))
    expect(received.headers["user-agent"]).toBe("Midas/iOS-test")
    expect(received.headers["x-midas-app-id"]).toBe("main")
    expect(received.headers["sec-fetch-mode"]).toBe("navigate")
  } finally {
    await server.stop()
  }
})

test("streams SSE through the iOS-profile client", async () => {
  let receivedHeaders: Record<string, string> = {}
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      receivedHeaders = Object.fromEntries(request.headers)
      return new Response("event: PriceUpdate\ndata: {\"p\":1}\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })

  try {
    const frames: SseFrame[] = []
    const stream = new FetchTransport().stream({
      url: `http://127.0.0.1:${server.port}/events`,
      headers: {
        accept: "text/event-stream",
        "user-agent": "Midas/iOS-test",
      },
    })
    for await (const frame of stream) frames.push(frame)

    expect(frames).toEqual([{ event: "PriceUpdate", data: '{"p":1}' }])
    expect(receivedHeaders.accept).toBe("text/event-stream")
    expect(receivedHeaders["user-agent"]).toBe("Midas/iOS-test")
  } finally {
    await server.stop()
  }
})

test("aborts an in-progress iOS-profile SSE request", async () => {
  const encoder = new TextEncoder()
  let keepAlive: ReturnType<typeof setInterval> | null = null
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"))
          keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 50)
        },
        cancel() {
          if (keepAlive) clearInterval(keepAlive)
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })

  const abort = new AbortController()
  const frames: SseFrame[] = []
  try {
    const reading = (async () => {
      for await (const frame of new FetchTransport().stream({
        url: `http://127.0.0.1:${server.port}/events`,
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      })) {
        frames.push(frame)
        abort.abort()
      }
    })()

    await expect(reading).rejects.toThrow()
    expect(frames).toEqual([{ event: null, data: "first" }])
  } finally {
    if (keepAlive) clearInterval(keepAlive)
    await server.stop(true)
  }
})
