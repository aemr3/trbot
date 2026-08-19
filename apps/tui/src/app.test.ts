import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { App } from "./app.ts"
import { ApplicationLog } from "./logging/application-log.ts"
import { DEFAULT_APP_PREFERENCES } from "@trbot/preferences/app.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import { createServerSession, type ServerSession } from "./server-session.ts"

// The terminal reaches an unreachable address here: constructing the app makes
// no requests, and these tests are about what it shows, not what it fetches.
function offlineSession(): ServerSession {
  return createServerSession({ config: { url: "http://127.0.0.1:1", token: "test-token", caPath: null } })
}

test("restores the terminal synchronously on Ctrl+C", async () => {
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

  expect(renderer.isDestroyed).toBe(true)
  expect(exitRequested).toBe(true)
  expect(preferencesClosed).toBe(true)
})

test("shows the sign-in screen when the server holds no provider session", async () => {
  const { renderer, waitForFrame } = await createTestRenderer({ width: 80, height: 20 })
  const session = offlineSession()
  const app = new App(renderer, { session, authenticated: false }, { exit: () => {} })
  app.mount()
  await waitForFrame((frame) => frame.includes("Sign in"))

  app.dispose()
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
    config: { url: `http://127.0.0.1:${server.port}`, token: "test-token", caPath: null },
  })
  const app = new App(renderer, { session, authenticated: null }, { exit: () => {}, sessionPollMs: 10 })
  app.mount()
  await waitForFrame((value) => value.includes("Connecting to the trbot server"))

  reachable = true
  await waitForFrame((value) => value.includes("Sign in"))

  app.dispose()
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
    config: { url: `http://127.0.0.1:${server.port}`, token: "test-token", caPath: null },
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
  await openWorkspace(app)
  expect(loads).toBe(1)

  app.dispose()
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

  await openWorkspace(app)

  // Trading is not blocked by a layout the terminal could not read.
  expect(logs.list().map((entry) => entry.scope)).toContain("Preferences")
  // And the settings stay unknown, which is what stops them being written back:
  // the change hook only persists once a load has succeeded.
  expect(loadedFlag(app)).toBe(false)
  expect(saved).toBeEmpty()

  app.dispose()
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
  const reporters: ((error: unknown) => void)[] = []
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
  session.close()
})

/**
 * Drives the transition the connecting and sign-in screens make on their own
 * once the server answers. Private because nothing outside the application
 * decides it; reached here to avoid standing up a whole server per assertion.
 */
function openWorkspace(app: App): Promise<void> {
  return (app as unknown as { showWorkspace(): Promise<void> }).showWorkspace()
}

/** Whether the settings are known, which is what gates writing them back. */
function loadedFlag(app: App): boolean {
  return (app as unknown as { preferencesLoaded: boolean }).preferencesLoaded
}
