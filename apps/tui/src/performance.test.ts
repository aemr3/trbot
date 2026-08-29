import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { PerformanceTelemetry } from "@trbot/telemetry/performance.ts"
import { observeRendererPerformance } from "./performance.ts"

test("measures a received market update through a completed native frame", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 20, gatherStats: true })
  const telemetry = new PerformanceTelemetry({ scope: "tui" })
  const detach = observeRendererPerformance(renderer, telemetry)

  telemetry.mark("market_received")
  telemetry.markEpoch("market_event", Date.now() - 20)
  await renderOnce()

  const report = telemetry.report()
  expect(report?.counters["renderer.frames"]).toBeGreaterThanOrEqual(1)
  expect(report?.distributions["market.receive_to_frame_ms"]?.count).toBe(1)
  expect(report?.distributions["market.event_to_frame_ms"]?.count).toBe(1)
  expect(report?.distributions["renderer.frame_ms"]?.count).toBeGreaterThanOrEqual(1)
  expect(report?.distributions["renderer.cells_updated"]?.count).toBeGreaterThanOrEqual(1)

  detach()
  renderer.destroy()
})
