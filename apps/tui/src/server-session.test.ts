import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpClient, type HttpClientOptions } from "@trbot/client/http.ts"
import { StreamConnection, type StreamConnectionOptions } from "@trbot/client/stream.ts"
import { createServerSession } from "./server-session.ts"

const AUTHORITY = "-----BEGIN CERTIFICATE-----\nnot-a-real-one\n-----END CERTIFICATE-----\n"

let directory: string | null = null

function authorityFile(): string {
  directory = mkdtempSync(join(tmpdir(), "trbot-ca-"))
  const path = join(directory, "ca.crt")
  writeFileSync(path, AUTHORITY)
  return path
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = null
})

/**
 * `TRBOT_SERVER_CA` names the authority `bun run server:cert` created, and a
 * remote server presents that certificate to the requests and to the socket
 * alike. Trusting it in one place only is worse than not trusting it at all: the
 * terminal appears to connect and then never receives a quote.
 *
 * The transport factory records the public constructor options, so this checks
 * the wiring without reaching into either client's private state.
 */
describe("reaching a server with a self-signed certificate", () => {
  test("the configured authority reaches both the requests and the socket", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "https://trbot.example:8443", token: "test-token", caPath: authorityFile() },
      transports: captured.transports,
    })

    expect(captured.httpOptions[0]?.ca).toBe(AUTHORITY)
    expect(captured.streamOptions[0]?.ca).toBe(AUTHORITY)

    session.close()
  })

  test("no configured authority leaves both on the system trust store", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "http://127.0.0.1:8080", token: "test-token", caPath: null },
      transports: captured.transports,
    })

    expect(captured.httpOptions[0]?.ca).toBeNull()
    expect(captured.streamOptions[0]?.ca).toBeNull()

    session.close()
  })

  test("one ephemeral client identity reaches both transports", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "http://127.0.0.1:8080", token: "test-token", caPath: null },
      transports: captured.transports,
    })

    const clientId = captured.httpOptions[0]?.clientId
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/)
    expect(captured.streamOptions[0]?.clientId).toBe(clientId)

    session.close()
  })

  // Failing here names the setting; failing later is a certificate error on
  // every request with nothing to say about why.
  test("an authority that cannot be read fails at startup, naming the setting", () => {
    expect(() =>
      createServerSession({
        config: { url: "https://trbot.example:8443", token: "test-token", caPath: "/nowhere/ca.crt" },
      }),
    ).toThrow(/TRBOT_SERVER_CA names \/nowhere\/ca\.crt/)
  })
})

/**
 * The socket reports a failure to whoever the application put there. Nothing
 * supplied that handler for a while, which made every stream failure silent —
 * an unreachable server looked exactly like a market with no ticks.
 */
test("a stream failure reaches the listener the application set", async () => {
  const session = createServerSession({
    // Port 1 refuses, so the socket fails as soon as it is opened.
    config: { url: "http://127.0.0.1:1", token: "test-token", caPath: null },
  })
  const failures: unknown[] = []
  session.onStreamError((error) => failures.push(error))

  session.stream.connect()
  const deadline = Date.now() + 3_000
  while (failures.length === 0 && Date.now() < deadline) await Bun.sleep(5)

  expect(failures).toHaveLength(1)
  session.close()
})

function captureTransports() {
  const httpOptions: HttpClientOptions[] = []
  const streamOptions: StreamConnectionOptions[] = []
  return {
    httpOptions,
    streamOptions,
    transports: {
      http(options: HttpClientOptions): HttpClient {
        httpOptions.push(options)
        return new HttpClient(options)
      },
      stream(options: StreamConnectionOptions): StreamConnection {
        streamOptions.push(options)
        return new StreamConnection(options)
      },
    },
  }
}
