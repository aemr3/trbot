import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ConnectingScreen } from "./connecting.ts"

test("wrapped connection failures do not overwrite the exit hint", async () => {
  const setup = await createTestRenderer({ width: 40, height: 20 })
  const url = "http://127.0.0.1:7717"
  const screen = new ConnectingScreen(setup.renderer, { url })

  try {
    setup.renderer.root.add(screen.root)
    screen.reportFailure(`Cannot reach the trbot server at ${url}`)
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    const exitLine = frame.split("\n").find((line) => line.includes("Ctrl+C to exit"))
    expect(frame).toContain(`${url} · Cannot`)
    expect(frame).toContain("reach the trbot server")
    expect(frame.match(/127\.0\.0\.1:7717/g)).toHaveLength(1)
    expect(exitLine).toBeDefined()
    expect(exitLine).not.toContain("127.0.0.1")
  } finally {
    screen.destroy()
    setup.renderer.destroy()
  }
})
