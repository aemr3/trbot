import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import type { PerformanceRecorder } from "@trbot/telemetry/performance.ts"

/** Records successful native frames, including work OpenTUI does after component updates. */
export function observeRendererPerformance(renderer: CliRenderer, telemetry: PerformanceRecorder): () => void {
  const onFrame = (): void => {
    const stats = renderer.getStats()
    telemetry.count("renderer.frames")
    telemetry.measure("market.receive_to_frame_ms", "market_received")
    telemetry.measureEpoch("market.event_to_frame_ms", "market_event")
    telemetry.observe("renderer.frame_ms", stats.nativeLastFrameTime)
    telemetry.observe("renderer.callback_ms", stats.frameCallbackTime)
    telemetry.observe("renderer.cells_updated", stats.cellsUpdated)
    if (stats.nativeRenderTime !== undefined) telemetry.observe("renderer.native_render_ms", stats.nativeRenderTime)
    if (stats.nativeStdoutWriteTime !== undefined) {
      telemetry.observe("renderer.stdout_write_ms", stats.nativeStdoutWriteTime)
    }
  }

  renderer.on(CliRenderEvents.FRAME, onFrame)
  return () => renderer.off(CliRenderEvents.FRAME, onFrame)
}
