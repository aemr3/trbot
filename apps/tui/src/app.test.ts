import { expect, test } from "bun:test"
import { CliRenderEvents, MouseEvent } from "@opentui/core"
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing"
import { App, configureTmuxKeyboard, forwardServerPerformance } from "./app.ts"
import { ApplicationLog } from "./logging/application-log.ts"
import { DEFAULT_APP_PREFERENCES } from "@trbot/preferences/app.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { ServerFrame } from "@trbot/protocol/stream.ts"
import { createServerSession, type ServerSession } from "./server-session.ts"

// The terminal reaches an unreachable address here: constructing the app makes
// no requests, and these tests are about what it shows, not what it fetches.
function offlineSession(): ServerSession {
  return createServerSession({ config: { url: "http://127.0.0.1:1", token: "test-token", tls: null } })
}

test("restores tmux keyboard disambiguation after delayed capabilities and refocus", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 20 })
  const enabled: string[] = []
  const restored: string[] = []
  const restore = configureTmuxKeyboard(renderer, {
    inTmux: false,
    settleMs: 0,
    write: (data) => enabled.push(data),
    restore: (data) => restored.push(data),
  })

  const capabilities = setRendererCapabilities(renderer, { multiplexer: "tmux" })
  renderer.emit(CliRenderEvents.CAPABILITIES, capabilities)
  await Bun.sleep(1)

  expect(enabled).toEqual(["\x1b[>4;2m"])
  renderer.emit(CliRenderEvents.FOCUS)
  expect(enabled).toEqual(["\x1b[>4;2m", "\x1b[>4;2m"])
  restore()
  expect(restored).toEqual(["\x1b[>4;0m"])
  renderer.destroy()
})

test("restores the terminal synchronously after Ctrl+C is confirmed", async () => {
  const { renderer, mockInput } = await createTestRenderer({
    width: 80,
    height: 20,
    kittyKeyboard: true,
  })
  let exitRequested = false
  let preferencesClosed = false
  const app = new App(
    renderer,
    { session: offlineSession(), authenticated: false },
    {
      exit: () => {
        expect(renderer.isDestroyed).toBe(true)
        exitRequested = true
      },
      closePreferences: () => {
        preferencesClosed = true
      },
    },
  )
  app.mount()

  mockInput.pressCtrlC()

  expect(renderer.isDestroyed).toBe(false)
  expect(exitRequested).toBe(false)
  expect(preferencesClosed).toBe(false)

  mockInput.pressCtrlC()

  expect(renderer.isDestroyed).toBe(true)
  expect(exitRequested).toBe(true)
  expect(preferencesClosed).toBe(true)
})

test("typing between Ctrl+C presses cancels quit confirmation", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true })
  let exitRequested = false
  const app = new App(
    renderer,
    { session: offlineSession(), authenticated: false },
    { exit: () => { exitRequested = true } },
  )
  app.mount()

  mockInput.pressCtrlC()
  await mockInput.typeText("x")
  mockInput.pressCtrlC()

  expect(exitRequested).toBe(false)
  expect(renderer.isDestroyed).toBe(false)

  mockInput.pressCtrlC()
  expect(exitRequested).toBe(true)
  expect(renderer.isDestroyed).toBe(true)
})

test("copies selected text by keyboard or mouse without exiting", async () => {
  const { renderer, mockInput } = await createTestRenderer({
    width: 80,
    height: 20,
    kittyKeyboard: true,
  })
  const copied: string[] = []
  let selectionCleared = false
  let exitRequested = false
  const selection = {
    currentFocusedRenderable: null,
    getSelection: () => ({
      getSelectedText: () => "823abd65-02b7-46f3-852d-36146a7280a2",
      selectedRenderables: [],
    }),
    clearSelection: () => {
      selectionCleared = true
    },
  }
  const app = new App(
    renderer,
    { session: offlineSession(), authenticated: false },
    {
      clipboard: { write: async (text) => void copied.push(text) },
      selection,
      exit: () => {
        exitRequested = true
      },
    },
  )
  app.mount()

  mockInput.pressCtrlC()

  expect(copied).toEqual(["823abd65-02b7-46f3-852d-36146a7280a2"])
  expect(selectionCleared).toBe(true)
  expect(exitRequested).toBe(false)
  expect(renderer.isDestroyed).toBe(false)

  app.root.processMouseEvent(new MouseEvent(app.root, {
    type: "up",
    button: 0,
    x: 0,
    y: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
  }))
  expect(copied).toEqual([
    "823abd65-02b7-46f3-852d-36146a7280a2",
    "823abd65-02b7-46f3-852d-36146a7280a2",
  ])

  app.dispose()
  renderer.destroy()
})

test("shows the sign-in screen when the server holds no provider session", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  const session = offlineSession()
  const app = new App(renderer, { session, authenticated: false }, { exit: () => {} })
  app.mount()
  await waitForFrame((frame) => frame.includes("Sign in"))

  app.dispose()
  renderer.destroy()
  session.close()
})

/**
 * A server that has not answered has not said the trader is signed out. Asking
 * them to sign in is an instruction to fix something, and this is not something
 * they can fix by doing it — the server is restarting, or the address is wrong.
 */
test("waits on an unreachable server instead of asking for a password", async () => {
  const { renderer, waitForFrame, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 })
  const session = offlineSession()
  const app = new App(renderer, { session, authenticated: null }, { exit: () => {}, sessionPollMs: 10 })
  app.mount()

  await waitForFrame((frame) => frame.includes("Connecting to the trbot server"))
  // Long enough for several failed attempts.
  await Bun.sleep(60)

  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).not.toContain("Sign in")
  expect(frame).not.toContain("Password")
  // And it says why, rather than spinning with nothing to show for it.
  expect(frame).toContain("127.0.0.1:1")

  app.dispose()
  renderer.destroy()
  session.close()
})

/** Only the server's own answer puts a sign-in screen in front of anyone. */
test("asks for a password once the server says there is no session", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  let reachable = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => (reachable ? Response.json({ authenticated: false }) : Response.error()),
  })
  const session = createServerSession({
    config: { url: `http://127.0.0.1:${server.port}`, token: "test-token", tls: null },
  })
  const app = new App(renderer, { session, authenticated: null }, { exit: () => {}, sessionPollMs: 10 })
  app.mount()
  await waitForFrame((value) => value.includes("Connecting to the trbot server"))

  reachable = true
  await waitForFrame((value) => value.includes("Sign in"))

  app.dispose()
  renderer.destroy()
  session.close()
  await server.stop(true)
})

/**
 * Being asked to sign in is not always something the trader has to answer. The
 * server signs itself in unattended, and it can be restarted underneath a
 * running terminal — so a terminal that starts during that restart is told
 * "no session" about a server that has one moments later. Without noticing, it
 * leaves someone typing a password they never needed.
 */
test("leaves the sign-in screen on its own once the server has a session", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  let authenticated = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === ROUTES.chatSessions) return Response.json([])
      return Response.json({ authenticated })
    },
  })
  const session = createServerSession({
    config: { url: `http://127.0.0.1:${server.port}`, token: "test-token", tls: null },
  })

  // Started while the server was still coming up.
  const app = new App(
    renderer,
    { session, authenticated: false },
    { exit: () => {}, sessionPollMs: 10 },
  )
  app.mount()
  await waitForFrame((frame) => frame.includes("Sign in"))

  // The server finishes resuming from its stored session.
  authenticated = true
  await waitForFrame((frame) => !frame.includes("Sign in"))

  app.dispose()
  renderer.destroy()
  session.close()
  await server.stop(true)
})

/**
 * Settings that could not be read are not settings the trader changed. Opening
 * on defaults writes those defaults back the first time anything is adjusted,
 * which is how a restart during startup silently erases a layout.
 */
test("reads the stored settings when the server appears, rather than defaulting at startup", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  let loads = 0
  const session = offlineSession()
  const app = new App(
    renderer,
    // Started mid-restart: neither the session nor the settings could be read.
    { session, authenticated: null },
    {
      exit: () => {},
      sessionPollMs: 10,
      loadPreferences: async () => {
        loads += 1
        return { ...DEFAULT_APP_PREFERENCES, instrumentSort: "name" }
      },
    },
  )
  app.mount()
  await waitForFrame((frame) => frame.includes("Connecting to the trbot server"))

  // Nothing read while there was nobody to read from, so nothing to default to.
  expect(loads).toBe(0)

  // The workspace opens only once the settings behind it are known.
  await app.openWorkspace()
  expect(loads).toBe(1)

  app.dispose()
  renderer.destroy()
  session.close()
})

test("opens the workspace even when the settings cannot be read, and writes nothing back", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 20 })
  const saved: unknown[] = []
  const logs = new ApplicationLog()
  const session = offlineSession()
  const app = new App(
    renderer,
    { session, authenticated: false },
    {
      exit: () => {},
      logs,
      // No `preferences` given, and the load keeps failing.
      loadPreferences: () => Promise.reject(new Error("the server is restarting")),
      savePreferences: (next) => saved.push(next),
    },
  )
  app.mount()

  await app.openWorkspace()

  // Trading is not blocked by a layout the terminal could not read.
  expect(logs.list().map((entry) => entry.scope)).toContain("Preferences")
  // And the settings stay unknown, which is what stops them being written back:
  // the change hook only persists once a load has succeeded.
  expect(app.preferencesReady).toBe(false)
  expect(saved).toBeEmpty()

  app.dispose()
  renderer.destroy()
  session.close()
})

/**
 * The socket reconnects silently, so a failure it never reports is a failure
 * nobody can see: an unreachable server reads as a market with no ticks. The
 * application is the only place that knows where to put it.
 */
test("a stream failure is written to the log the trader can open", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 20 })
  const session = offlineSession()
  const reporters: ((cause: unknown) => void)[] = []
  const logs = new ApplicationLog()
  const app = new App(
    renderer,
    {
      session: { ...session, onStreamError: (listener) => reporters.push(listener) },
      authenticated: false,
    },
    { logs, exit: () => {} },
  )
  app.mount()

  expect(reporters).toHaveLength(1)
  reporters[0]?.(new Error("The connection to the trbot server failed"))

  const [entry] = logs.list()
  expect(entry?.level).toBe("ERROR")
  expect(entry?.scope).toBe("Server stream")
  expect(entry?.message).toContain("trbot server")

  app.dispose()
  renderer.destroy()
  session.close()
})

test("server performance summaries are forwarded to the application log until detached", () => {
  const listeners = new Set<(frame: ServerFrame) => void>()
  const stream = {
    on(listener: (frame: ServerFrame) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const logs = new ApplicationLog()
  const detach = forwardServerPerformance(stream, logs)
  const frame: ServerFrame = {
    type: "performanceReport",
    report: {
      scope: "server",
      windowMs: 10_000,
      counters: { "ws.sent.frames": 4 },
      distributions: {},
    },
  }

  for (const listener of listeners) listener(frame)

  expect(logs.list()).toMatchObject([{
    level: "INFO",
    scope: "Server performance",
    message: "10-second performance summary",
  }])
  expect(logs.list()[0]?.details).toContain('"ws.sent.frames": 4')

  detach()
  for (const listener of listeners) listener(frame)
  expect(logs.list()).toHaveLength(1)
})

test("renderer failures reach the application log without opening a debug overlay", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 20 })
  const session = offlineSession()
  const logs = new ApplicationLog()
  const app = new App(
    renderer,
    { session, authenticated: false },
    { logs, exit: () => {} },
  )
  app.mount()

  renderer.emit(CliRenderEvents.RENDER_ERROR, {
    error: new Error("A renderable failed"),
    renderable: app.root,
  })

  expect(logs.list()).toMatchObject([{
    level: "ERROR",
    scope: "Renderer",
    message: "A renderable failed",
  }])

  app.dispose()
  expect(renderer.listenerCount(CliRenderEvents.RENDER_ERROR)).toBe(0)
  renderer.destroy()
  session.close()
})
