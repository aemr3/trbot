import { expect, test } from "bun:test"
import { PerformanceReportSchema, PerformanceTelemetry } from "./performance.ts"

test("validates complete performance reports at transport boundaries", () => {
  const report = {
    scope: "server",
    windowMs: 10_000,
    counters: { "ws.sent.frames": 4 },
    distributions: {
      event_loop_lag_ms: { count: 40, p50: 0.2, p95: 1.5, max: 3 },
    },
  }

  expect(PerformanceReportSchema.parse(report)).toEqual(report)
  expect(PerformanceReportSchema.safeParse({
    ...report,
    distributions: { event_loop_lag_ms: { count: 40, p50: 0.2 } },
  }).success).toBe(false)
})

test("reports counters and bounded timing percentiles, then starts a fresh window", () => {
  let now = 100
  let epochNow = 1_000
  const telemetry = new PerformanceTelemetry({ scope: "test", now: () => now, epochNow: () => epochNow })

  telemetry.count("frames", 2)
  for (let value = 1; value <= 100; value++) telemetry.observe("decode_ms", value)
  telemetry.mark("received")
  now = 112.3456
  telemetry.measure("receive_to_frame_ms", "received")
  telemetry.markEpoch("event", 900)
  epochNow = 1_125
  telemetry.measureEpoch("event_to_frame_ms", "event")

  expect(telemetry.report()).toEqual({
    scope: "test",
    windowMs: 12.346,
    counters: { frames: 2 },
    distributions: {
      decode_ms: { count: 100, p50: 50, p95: 95, max: 100 },
      event_to_frame_ms: { count: 1, p50: 225, p95: 225, max: 225 },
      receive_to_frame_ms: { count: 1, p50: 12.346, p95: 12.346, max: 12.346 },
    },
  })
  expect(telemetry.report()).toBeNull()
})

test("keeps only the latest mark and ignores invalid observations", () => {
  let now = 0
  const telemetry = new PerformanceTelemetry({ scope: "test", now: () => now })

  telemetry.mark("market")
  now = 10
  telemetry.mark("market")
  now = 15
  telemetry.measure("latency_ms", "market")
  telemetry.observe("latency_ms", Number.NaN)
  telemetry.observe("latency_ms", -1)

  expect(telemetry.report()?.distributions.latency_ms).toEqual({ count: 1, p50: 5, p95: 5, max: 5 })
})
