import type {
  DepthBook,
  DepthBookSnapshotLoader,
  DepthStatus,
  DepthStream,
} from "@trbot/market/depth.ts"

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_SETTLE_MS = 100

interface PendingSnapshot {
  promise: Promise<DepthBook>
  cancel(): void
  waiters: number
}

export interface LiveDepthBookLoaderOptions {
  openStream(): DepthStream
  timeoutMs?: number
  /** Lets the opening level batch and HTTP trade seed assemble before resolving. */
  settleMs?: number
}

/** Takes one fresh opening book from the shared realtime connection per request. */
export class LiveDepthBookLoader implements DepthBookSnapshotLoader {
  private readonly pending = new Map<string, PendingSnapshot>()

  constructor(private readonly options: LiveDepthBookLoaderOptions) {}

  async loadDepthBookSnapshot(
    symbol: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DepthBook> {
    if (options.signal?.aborted) throw cancelledError()

    const normalized = normalizeSymbol(symbol)
    let pending = this.pending.get(normalized)
    if (!pending) {
      const created = this.capture(normalized)
      pending = created
      this.pending.set(normalized, created)
      void created.promise.then(
        () => this.clearPending(normalized, created),
        () => this.clearPending(normalized, created),
      )
    }

    pending.waiters += 1
    try {
      return await waitForSnapshot(pending.promise, options.signal)
    } finally {
      pending.waiters -= 1
      if (pending.waiters === 0 && this.pending.get(normalized) === pending) pending.cancel()
    }
  }

  private clearPending(symbol: string, pending: PendingSnapshot): void {
    if (this.pending.get(symbol) === pending) this.pending.delete(symbol)
  }

  private capture(symbol: string): PendingSnapshot {
    let cancel = (): void => {}
    const promise = new Promise<DepthBook>((resolve, reject) => {
      let stream: DepthStream | null = null
      let live = false
      let started = false
      let settled = false
      let latest: DepthBook | null = null
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: { value: DepthBook } | { error: Error }): void => {
        if (settled) return
        settled = true
        if (settleTimer) clearTimeout(settleTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        stream?.stop()
        if ("value" in result) resolve(result.value)
        else reject(result.error)
      }

      cancel = () => finish({ error: cancelledError() })

      try {
        stream = this.options.openStream()
      } catch (cause) {
        finish({ error: asError(cause) })
        return
      }

      timeoutTimer = setTimeout(
        () => finish({ error: new Error(`Timed out waiting for an order book for ${symbol}`) }),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      stream.subscribe((book) => {
        if (!live) return
        latest = book
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (latest) finish({ value: latest })
        }, this.options.settleMs ?? DEFAULT_SETTLE_MS)
      })
      stream.onStatusChange((status) => {
        live = status === "live"
        if (!live && settleTimer) {
          clearTimeout(settleTimer)
          settleTimer = null
        }
        const error = depthStatusError(status, symbol, started)
        if (error) finish({ error })
      })

      try {
        started = true
        stream.start(symbol)
      } catch (cause) {
        finish({ error: asError(cause) })
      }
    })

    return { promise, cancel, waiters: 0 }
  }
}

function depthStatusError(status: DepthStatus, symbol: string, started: boolean): Error | null {
  if (status === "unavailable") return new Error(`Order book is unavailable for ${symbol}`)
  if (status === "idle" && started) return new Error(`Order book subscription ended for ${symbol}`)
  return null
}

function waitForSnapshot(
  promise: Promise<DepthBook>,
  signal?: AbortSignal,
): Promise<DepthBook> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelledError())

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { value: DepthBook } | { error: Error }): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      if ("value" in result) resolve(result.value)
      else reject(result.error)
    }
    const onAbort = () => finish({ error: cancelledError() })
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish({ value }),
      (cause) => finish({ error: asError(cause) }),
    )
  })
}

function cancelledError(): Error {
  return new Error("Market-data request was cancelled")
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}
