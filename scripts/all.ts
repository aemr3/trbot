import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { loadClientConfig, workspaceRoot } from "@trbot/config"

/**
 * Runs the server and the terminal together, both watching for changes.
 *
 * The terminal needs the real terminal to itself: anything else writing to the
 * same stdout lands in the middle of a frame and corrupts the display. So the
 * server's output goes to a log file and only the terminal inherits the TTY.
 * Follow the server with `tail -f data/server.log`.
 */
const ROOT = workspaceRoot()
const LOG_PATH = resolve(ROOT, "data/server.log")
const READY_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 150

const config = loadClientConfig()

await mkdir(dirname(LOG_PATH), { recursive: true, mode: 0o700 })
const log = Bun.file(LOG_PATH).writer()

const server = Bun.spawn({
  cmd: ["bun", "--watch", "run", "apps/server/src/index.ts"],
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
})

void pipe(server.stdout)
void pipe(server.stderr)

async function pipe(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) {
    log.write(chunk)
    log.flush()
  }
}

let terminal: Bun.Subprocess | null = null
let shuttingDown = false

function shutdown(code = 0): never {
  shuttingDown = true
  terminal?.kill()
  server.kill()
  log.end()
  process.exit(code)
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

// The terminal asks the server for the session as soon as it starts, so it waits
// for the server to answer rather than racing it and falling back to a login.
if (!(await waitForServer())) {
  console.error(`The server did not become ready within ${READY_TIMEOUT_MS / 1000}s. See ${LOG_PATH}`)
  shutdown(1)
}

console.log(`Server ready at ${config.url} · logging to ${LOG_PATH}`)

terminal = Bun.spawn({
  cmd: ["bun", "--watch", "run", "apps/tui/src/index.ts"],
  cwd: ROOT,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

// Closing the terminal takes the server down with it: this command owns both.
shutdown(await terminal.exited)

async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const ca = config.caPath ? await Bun.file(config.caPath).text() : null

  while (Date.now() < deadline) {
    if (shuttingDown) return false
    if (server.exitCode !== null) return false
    try {
      const response = await fetch(`${config.url}/v1/health`, ca ? { tls: { ca } } : {})
      if (response.ok) return true
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  return false
}
