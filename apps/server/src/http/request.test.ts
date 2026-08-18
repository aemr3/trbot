import { describe, expect, test } from "bun:test"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ndjson } from "./request.ts"

/** Every frame the response carried, in order. */
async function framesOf(response: Response): Promise<unknown[]> {
  const text = await response.text()
  return text.trim().split("\n").map((line) => JSON.parse(line) as unknown)
}

describe("streamed responses", () => {
  // A silent socket is a closed socket: the connection's idle limit does not
  // care that the model is still thinking, so the stream has to keep talking.
  test("says something immediately, before there is anything to say", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    const response = ndjson(async (emit) => {
      await held
      emit({ delta: "the first token" })
    })

    // Reading the head of the body before the work finishes: the heartbeat is
    // already there, which is what flushes the headers to the client.
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ heartbeat: true })

    release()
    void reader.cancel()
  })

  test("keeps beating while the work runs", async () => {
    const response = ndjson(async (emit) => {
      await Bun.sleep(45)
      emit({ delta: "done" })
    }, 10)

    const frames = await framesOf(response)
    expect(frames.filter((frame) => (frame as { heartbeat?: boolean }).heartbeat)).not.toBeEmpty()
    expect(frames.at(-1)).toEqual({ delta: "done" })
  })

  test("a failure becomes the last frame rather than a status", async () => {
    const response = ndjson(async (emit) => {
      emit({ delta: "half an answer" })
      throw new ProtocolError("upstream_error", "the model gave up")
    })

    expect(response.status).toBe(200)
    const frames = await framesOf(response)
    expect(frames).toContainEqual({ delta: "half an answer" })
    expect(frames.at(-1)).toEqual({ error: { code: "upstream_error", message: "the model gave up" } })
  })

  test("stops beating once the work is done", async () => {
    const response = ndjson(async (emit) => {
      emit({ delta: "done" })
    }, 10)

    const frames = await framesOf(response)
    await Bun.sleep(40)
    // Nothing was enqueued after close, which would have thrown.
    expect(frames.at(-1)).toEqual({ delta: "done" })
  })
})
