import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { TradingWorkspaceScreen } from "./trading-workspace.ts"

/**
 * A panel, near enough for the workspace to be driven against.
 *
 * `capturesInput` is the only thing the workspace asks of a panel beyond drawing
 * itself, so a fake that answers it exercises the tab shortcuts without a real screen.
 */
function panel(renderer: RenderContext, label: string, options: { capturesInput?: boolean } = {}): {
  root: BoxRenderable
  keys: KeyEvent[]
  handleKey(key: KeyEvent): void
  capturesInput(): boolean
  destroy(): void
} {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%" })
  root.add(new TextRenderable(renderer, { content: label }))
  const keys: KeyEvent[] = []
  return {
    root,
    keys,
    handleKey: (key) => {
      keys.push(key)
    },
    capturesInput: () => options.capturesInput ?? false,
    destroy: () => {
      if (!root.isDestroyed) root.destroyRecursively()
    },
  }
}

async function mountWorkspace(options: { capturesInput?: boolean } = {}) {
  const harness = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  const trade = panel(harness.renderer, "TRADE PANEL", options)
  const chat = panel(harness.renderer, "CHAT PANEL", options)
  const logs = panel(harness.renderer, "LOG PANEL", options)
  const workspace = new TradingWorkspaceScreen(harness.renderer, { trade, chat, logs })
  harness.renderer.root.add(workspace.root)
  workspace.mount()
  return { ...harness, workspace, trade, chat, logs }
}

test("^A cycles the tabs, and keeps doing it while a panel is taking text", async () => {
  // The point of a control key: the letters T, C and L belong to whatever is taking
  // text, so they cannot be the way out of it.
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace({ capturesInput: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  // Round the three and back to where it started.
  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("^⇧A cycles the other way, where the terminal reports the shift", async () => {
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  // Backwards from the first tab wraps to the last.
  mockInput.pressKey("a", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  mockInput.pressKey("a", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  mockInput.pressKey("a", { ctrl: true, shift: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("each tab answers to its own initial while no panel is taking text", async () => {
  const { renderer, mockInput, waitForFrame, workspace } = await mountWorkspace()
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  mockInput.pressKey("l", { shift: true })
  await waitForFrame((frame) => frame.includes("LOG PANEL"))
  mockInput.pressKey("c", { shift: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))

  workspace.destroy()
  renderer.destroy()
})

test("a panel taking text keeps the letters, and the workspace keeps the control keys", async () => {
  const { renderer, mockInput, waitForFrame, workspace, trade } = await mountWorkspace({ capturesInput: true })
  await waitForFrame((frame) => frame.includes("TRADE PANEL"))

  // A tab initial typed into a field is text, and reaches the panel rather than the
  // tab bar: a trader typing "Logs" would otherwise leave the screen mid-word.
  mockInput.pressKey("l", { shift: true })
  await Bun.sleep(5)
  expect(trade.keys.map((key) => key.name)).toEqual(["l"])

  mockInput.pressKey("a", { ctrl: true })
  await waitForFrame((frame) => frame.includes("CHAT PANEL"))
  // The workspace took that one, so the panel never saw it.
  expect(trade.keys.map((key) => key.name)).toEqual(["l"])

  workspace.destroy()
  renderer.destroy()
})
