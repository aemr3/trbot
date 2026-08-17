export interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  body: string
  retryAfterMs?: number
}

export interface StreamRequest {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
}

export interface SseFrame {
  event: string | null
  data: string
}

export interface Transport {
  request(request: HttpRequest): Promise<HttpResponse>
  // Optional server-sent-events channel; only transports that can stream a
  // response body implement it.
  stream?(request: StreamRequest): AsyncGenerator<SseFrame>
}

export class StreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Stream returned HTTP ${status}`)
    this.name = "StreamHttpError"
  }
}

export function isTransientStreamError(error: unknown): boolean {
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const value = pending.shift()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (value instanceof StreamHttpError && value.status >= 500) return true
    if (value instanceof Error && value.message.includes("socket connection was closed unexpectedly")) return true
    const record = value as Record<string, unknown>
    for (const key of ["cause", "error", "errors"]) {
      const nested = record[key]
      if (Array.isArray(nested)) pending.push(...nested)
      else if (nested !== undefined) pending.push(nested)
    }
  }
  return false
}

export class FetchTransport implements Transport {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })

    return {
      status: response.status,
      body: await response.text(),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    }
  }

  async *stream(request: StreamRequest): AsyncGenerator<SseFrame> {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: request.signal,
    })
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new StreamHttpError(response.status)
    }
    yield* readSse(response.body, request.signal)
  }
}

function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

// Parses a text/event-stream body into discrete frames. Frames are separated by
// a blank line; within a frame, `event:` names it and one or more `data:` lines
// form the payload. Comment lines (`:` prefix) and other fields are ignored.
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = parseFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (frame) yield frame
        boundary = buffer.indexOf("\n\n")
      }
    }
    const trailing = parseFrame(buffer)
    if (trailing) yield trailing
  } finally {
    reader.releaseLock()
    if (!signal?.aborted) void body.cancel().catch(() => {})
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null
  const data: string[] = []
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null
}
