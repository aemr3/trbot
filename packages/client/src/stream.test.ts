import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { parseClientFrame, type ServerFrame } from "@trbot/protocol/stream.ts"
import { PerformanceTelemetry } from "@trbot/telemetry/performance.ts"
import { StreamConnection } from "./stream.ts"

/**
 * The reconnect loop retries forever and says nothing, so a failure that never
 * clears — an unreachable server, a certificate the terminal does not trust —
 * has to be reported exactly once rather than on every attempt. Reporting each
 * one would fill the log with a single fact repeated every few seconds.
 */

const opened: { close(): void }[] = []
const servers: Server<undefined>[] = []

afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  for (const server of servers.splice(0)) void server.stop(true)
})

function track<T extends { close(): void }>(connection: T): T {
  opened.push(connection)
  return connection
}

/**
 * A server that accepts the stream upgrade and records what it is sent. The
 * subscription a client replays on connect is what marks it as attached.
 */
function listen(port: number, received: string[]): Server<undefined> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(_socket, data) {
        received.push(String(data))
      },
    },
  })
  servers.push(server)
  return server
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

test("reports an unreachable server once, not once per retry", async () => {
  const failures: unknown[] = []
  const connection = track(
    new StreamConnection({
      // Port 1 refuses, and keeps refusing, so the loop runs the whole time.
      url: "http://127.0.0.1:1",
      token: "test-token",
      reconnectDelaysMs: [5],
      onError: (error) => failures.push(error),
    }),
  )

  connection.connect()
  await waitFor(() => failures.length > 0)
  // Long enough for many more attempts at a five millisecond delay.
  await Bun.sleep(150)

  expect(failures).toHaveLength(1)
  expect(failures[0]).toBeInstanceOf(Error)
  expect(failures[0] instanceof Error ? failures[0].message : "").toMatch(/trbot server/)
})

/**
 * Every channel rides this one socket, so losing it means none of them is live.
 * Without saying so, the panels keep their live marker beside a price that
 * stopped moving when the server died — the one reading a trader acts on.
 */
test("marks every channel stale when the socket drops", async () => {
  const port = 47_914
  const received: string[] = []
  const server = listen(port, received)
  const frames: ServerFrame[] = []
  const connection = track(
    new StreamConnection({ url: `http://127.0.0.1:${port}`, token: "test-token", reconnectDelaysMs: [5] }),
  )
  connection.on((frame) => frames.push(frame))

  connection.subscribe("quotes", { type: "subscribe", channel: "quotes", symbols: ["F_XU0300826"] })
  await waitFor(() => received.length === 1)
  expect(frames).toBeEmpty()

  await server.stop(true)
  await waitFor(() => frames.length > 0)

  expect(frames.filter((frame) => frame.type === "status")).toEqual([
    { type: "status", channel: "quotes", connected: false },
    { type: "status", channel: "equityQuotes", connected: false },
    { type: "status", channel: "depth", connected: false },
    { type: "status", channel: "account", connected: false },
  ])
  // Depth reports itself in its own vocabulary and ignores the generic frame
  // above, so without this the book keeps its live marker through the outage.
  expect(frames).toContainEqual({ type: "depthStatus", status: "connecting" })
})

/**
 * The replay on open sends what is subscribed now. A queued unsubscribe would
 * be written after it and undo a subscription taken out in the meantime,
 * leaving the client watching a channel the server has stopped sending.
 */
test("a subscription taken out again before the socket opens survives", async () => {
  const port = 47_916
  const received: string[] = []
  const connection = track(
    new StreamConnection({ url: `http://127.0.0.1:${port}`, token: "test-token", reconnectDelaysMs: [5] }),
  )

  // All three before anything is connected: the server is not even listening.
  connection.subscribe("depth", { type: "subscribe", channel: "depth", symbol: "F_XU0300826" })
  connection.unsubscribe("depth", { type: "unsubscribe", channel: "depth" })
  connection.subscribe("depth", { type: "subscribe", channel: "depth", symbol: "F_THYAO0826" })

  listen(port, received)
  await waitFor(() => received.length > 0)
  await Bun.sleep(50)

  const sent = received.map((payload) => {
    const frame = parseClientFrame(payload)
    if (!frame) throw new Error("The client emitted an invalid stream frame")
    return frame
  })
  expect(sent).toEqual([
    { type: "subscribe", channel: "depth", symbol: "F_THYAO0826" },
  ])
})

test("a listener can be taken off again, so a replaced screen stops hearing frames", async () => {
  const port = 47_917
  const received: string[] = []
  const server = listen(port, received)
  const heard: ServerFrame[] = []
  const connection = track(
    new StreamConnection({ url: `http://127.0.0.1:${port}`, token: "test-token", reconnectDelaysMs: [5] }),
  )
  const detach = connection.on((frame) => heard.push(frame))

  connection.subscribe("account", { type: "subscribe", channel: "account" })
  await waitFor(() => received.length === 1)

  detach()
  await server.stop(true)
  await Bun.sleep(50)

  expect(heard).toBeEmpty()
})

test("records WebSocket payload and decode metrics without changing dispatch", async () => {
  const port = 47_918
  const frame: ServerFrame = {
    type: "quotes",
    update: { symbol: "AAA", lastPrice: 100, sessionStatus: null, timestamp: Date.now() },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(socket) {
        socket.send(JSON.stringify(frame))
      },
      message() {},
    },
  })
  servers.push(server)

  const telemetry = new PerformanceTelemetry({ scope: "tui" })
  const heard: ServerFrame[] = []
  const connection = track(new StreamConnection({
    url: `http://127.0.0.1:${port}`,
    token: "test-token",
    performance: telemetry,
  }))
  connection.on((received) => heard.push(received))
  connection.connect()

  await waitFor(() => heard.length === 1)

  expect(heard).toEqual([frame])
  const report = telemetry.report()
  expect(report?.counters["ws.received.frames"]).toBe(1)
  expect(report?.counters["ws.received.quotes"]).toBe(1)
  expect(report?.counters["ws.received.bytes"]).toBeGreaterThan(0)
  expect(report?.distributions["ws.decode_ms"]?.count).toBe(1)
  expect(report?.distributions["market.age_at_receive_ms"]?.count).toBe(1)
})

test("reports again once a connection that came back has failed a second time", async () => {
  const port = 47_913
  const received: string[] = []
  const failures: unknown[] = []
  let server = listen(port, received)
  const connection = track(
    new StreamConnection({
      url: `http://127.0.0.1:${port}`,
      token: "test-token",
      reconnectDelaysMs: [5],
      onError: (error) => failures.push(error),
    }),
  )

  // The subscription is replayed on every connect, so it marks each attachment
  // — exactly once per connection, never queued as pending as well.
  connection.subscribe("account", { type: "subscribe", channel: "account" })
  await waitFor(() => received.length > 0)
  await Bun.sleep(50)
  expect(received).toHaveLength(1)
  expect(failures).toHaveLength(0)

  // The server goes away, and stays away long enough for several retries.
  await server.stop(true)
  await waitFor(() => failures.length === 1)
  await Bun.sleep(80)
  expect(failures).toHaveLength(1)

  // It comes back, so the next outage is a new thing worth saying.
  server = listen(port, received)
  await waitFor(() => received.length === 2)
  await server.stop(true)
  await waitFor(() => failures.length === 2)
})
