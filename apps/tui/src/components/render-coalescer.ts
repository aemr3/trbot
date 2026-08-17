// Collapses a burst of stream events into one content rebuild. Stream handlers
// store the latest state and call schedule(); the rebuild runs via
// setImmediate, after the current event-loop turn has drained. An SSE network
// chunk carrying hundreds of events is parsed microtask-by-microtask inside
// one turn, so the burst costs one rebuild instead of hundreds. The render
// callback reads current state, so the newest data always wins.
export class RenderCoalescer {
  private scheduled = false
  private cancelled = false

  constructor(private readonly render: () => void) {}

  schedule(): void {
    if (this.scheduled || this.cancelled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      if (!this.cancelled) this.render()
    })
  }

  // Permanently stops future renders, for teardown.
  cancel(): void {
    this.cancelled = true
  }
}
