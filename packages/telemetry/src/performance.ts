const DEFAULT_REPORT_INTERVAL_MS = 10_000
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 250
const MAX_SAMPLES = 4_096

export interface PerformanceDistribution {
  count: number
  p50: number
  p95: number
  max: number
}

export interface PerformanceReport {
  scope: string
  windowMs: number
  counters: Record<string, number>
  distributions: Record<string, PerformanceDistribution>
}

export interface PerformanceRecorder {
  count(name: string, value?: number): void
  observe(name: string, value: number): void
  mark(name: string): void
  measure(name: string, mark: string): void
  markEpoch(name: string, timestamp: number): void
  measureEpoch(name: string, mark: string): void
}

export interface PerformanceTelemetryOptions {
  scope: string
  intervalMs?: number
  now?: () => number
  epochNow?: () => number
  onReport?: (report: PerformanceReport) => void
}

class Samples {
  private readonly values: number[] = []
  private cursor = 0
  count = 0

  add(value: number): void {
    this.count += 1
    if (this.values.length < MAX_SAMPLES) {
      this.values.push(value)
      return
    }
    this.values[this.cursor] = value
    this.cursor = (this.cursor + 1) % MAX_SAMPLES
  }

  summary(): PerformanceDistribution {
    const sorted = [...this.values].sort((left, right) => left - right)
    return {
      count: this.count,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: rounded(sorted.at(-1) ?? 0),
    }
  }
}

/** Aggregates hot-path counters and timings into bounded periodic summaries. */
export class PerformanceTelemetry implements PerformanceRecorder {
  private readonly counters = new Map<string, number>()
  private readonly distributions = new Map<string, Samples>()
  private readonly marks = new Map<string, number>()
  private readonly epochMarks = new Map<string, number>()
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly epochNow: () => number
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null
  private windowStartedAt: number
  private nextEventLoopSampleAt = 0

  constructor(private readonly options: PerformanceTelemetryOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_REPORT_INTERVAL_MS
    this.now = options.now ?? performance.now.bind(performance)
    this.epochNow = options.epochNow ?? Date.now
    this.windowStartedAt = this.now()
  }

  start(): void {
    if (this.reportTimer !== null) return
    this.counters.clear()
    this.distributions.clear()
    this.windowStartedAt = this.now()
    this.nextEventLoopSampleAt = this.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS
    this.eventLoopTimer = setInterval(() => this.sampleEventLoop(), EVENT_LOOP_SAMPLE_INTERVAL_MS)
    this.reportTimer = setInterval(() => {
      const report = this.report()
      if (report) this.options.onReport?.(report)
    }, this.intervalMs)
  }

  stop(): void {
    if (this.reportTimer !== null) clearInterval(this.reportTimer)
    if (this.eventLoopTimer !== null) clearInterval(this.eventLoopTimer)
    this.reportTimer = null
    this.eventLoopTimer = null
  }

  count(name: string, value = 1): void {
    if (!Number.isFinite(value)) return
    this.counters.set(name, (this.counters.get(name) ?? 0) + value)
  }

  observe(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    const samples = this.distributions.get(name) ?? new Samples()
    samples.add(value)
    this.distributions.set(name, samples)
  }

  /** Remembers only the newest occurrence, matching latest-state rendering. */
  mark(name: string): void {
    this.marks.set(name, this.now())
  }

  measure(name: string, mark: string): void {
    const startedAt = this.marks.get(mark)
    if (startedAt === undefined) return
    this.marks.delete(mark)
    this.observe(name, this.now() - startedAt)
  }

  /** Stores an upstream epoch timestamp so a later process stage can finish it. */
  markEpoch(name: string, timestamp: number): void {
    if (Number.isFinite(timestamp) && timestamp > 0) this.epochMarks.set(name, timestamp)
  }

  measureEpoch(name: string, mark: string): void {
    const startedAt = this.epochMarks.get(mark)
    if (startedAt === undefined) return
    this.epochMarks.delete(mark)
    this.observe(name, this.epochNow() - startedAt)
  }

  /** Returns and clears one reporting window without disturbing pending marks. */
  report(): PerformanceReport | null {
    const endedAt = this.now()
    const windowMs = rounded(endedAt - this.windowStartedAt)
    this.windowStartedAt = endedAt
    if (this.counters.size === 0 && this.distributions.size === 0) return null

    const report: PerformanceReport = {
      scope: this.options.scope,
      windowMs,
      counters: Object.fromEntries([...this.counters].sort(([left], [right]) => left.localeCompare(right))),
      distributions: Object.fromEntries(
        [...this.distributions]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, samples]) => [name, samples.summary()]),
      ),
    }
    this.counters.clear()
    this.distributions.clear()
    return report
  }

  private sampleEventLoop(): void {
    const now = this.now()
    this.observe("event_loop_lag_ms", Math.max(0, now - this.nextEventLoopSampleAt))
    this.nextEventLoopSampleAt = now + EVENT_LOOP_SAMPLE_INTERVAL_MS
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return rounded(sorted[index] ?? 0)
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}
