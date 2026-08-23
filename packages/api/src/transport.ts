import {
  createTransport,
  fetch as fingerprintFetch,
  type RequestInit as FingerprintRequestInit,
  type Transport as FingerprintTransport,
} from "wreq-js"

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

interface SseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
  releaseLock(): void
}

interface SseBody {
  getReader(): SseBodyReader
  cancel(): Promise<void>
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

export function isTransientStreamError(cause: unknown): boolean {
  const pending: unknown[] = [cause]
  const seen = new Set<Error>()
  while (pending.length > 0) {
    const value = pending.shift()
    if (!(value instanceof Error) || seen.has(value)) continue
    seen.add(value)
    if (value instanceof StreamHttpError && value.status >= 500) return true
    if (value.message.includes("socket connection was closed unexpectedly")) return true
    if (value.cause !== undefined) pending.push(value.cause)
    if (value instanceof AggregateError) pending.push(...value.errors)
  }
  return false
}

export class FetchTransport implements Transport {
  private fingerprintTransport: Promise<FingerprintTransport> | null = null
  private closed = false

  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.fetch(request.url, {
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
    const response = await this.fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: request.signal,
    })
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new StreamHttpError(response.status)
    }
    yield* readSse(response.body, request.signal)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.fingerprintTransport) {
      void this.fingerprintTransport.then((transport) => transport.close()).catch(() => {})
    }
  }

  /** Uses the iOS version named by the Midas application user agent. */
  private async fetch(url: string, init: FingerprintRequestInit) {
    if (this.closed) throw new Error("API HTTP transport is closed")
    this.fingerprintTransport ??= createTransport({
      browser: "safari_ios_18.1.1",
      os: "ios",
    })
    return fingerprintFetch(url, {
      ...init,
      transport: await this.fingerprintTransport,
    })
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
export async function* readSse(body: SseBody, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const cancel = () => void reader.cancel().catch(() => {})
  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (signal?.aborted) throw signal.reason
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
    signal?.removeEventListener("abort", cancel)
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
