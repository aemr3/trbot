const FRAME_INTERVAL_MS = 1_000 / 30

interface PendingRender {
  immediate: boolean
  cancel(): void
}

// Collapses stream events into one content rebuild. schedule() runs after the
// current event-loop turn; scheduleFrame() also limits sustained updates to 30
// FPS. Both callbacks read current state, so skipped intermediate states cost
// nothing and the newest data always wins.
export class RenderCoalescer {
  private pending: PendingRender | null = null
  private cancelled = false
  private lastFrameRenderedAt: number | null = null

  constructor(
    private readonly render: () => void,
    private readonly onError?: (error: Error) => void,
  ) {}

  schedule(): void {
    if (this.cancelled || this.pending?.immediate) return
    this.pending?.cancel()
    this.queueImmediate(false)
  }

  /** Schedules a latest-state rebuild without exceeding the TUI's 30 FPS budget. */
  scheduleFrame(): void {
    if (this.cancelled || this.pending) return
    const elapsed = this.lastFrameRenderedAt === null
      ? FRAME_INTERVAL_MS
      : performance.now() - this.lastFrameRenderedAt
    const delay = Math.max(0, FRAME_INTERVAL_MS - elapsed)
    if (delay === 0) {
      this.queueImmediate(true)
      return
    }
    const handle = setTimeout(() => this.flush(true), delay)
    this.pending = { immediate: false, cancel: () => clearTimeout(handle) }
  }

  private queueImmediate(frameScheduled: boolean): void {
    const handle = setImmediate(() => this.flush(frameScheduled))
    this.pending = { immediate: true, cancel: () => clearImmediate(handle) }
  }

  private flush(frameScheduled: boolean): void {
    this.pending = null
    if (this.cancelled) return
    if (frameScheduled) this.lastFrameRenderedAt = performance.now()
    try {
      this.render()
    } catch (error) {
      if (!this.onError) throw error
      this.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  // Permanently stops future renders, for teardown.
  cancel(): void {
    this.cancelled = true
    this.pending?.cancel()
    this.pending = null
  }
}
