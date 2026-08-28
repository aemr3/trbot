import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpClient, type HttpClientOptions } from "@trbot/client/http.ts"
import { StreamConnection, type StreamConnectionOptions } from "@trbot/client/stream.ts"
import { createServerSession } from "./server-session.ts"

const AUTHORITY = "-----BEGIN CERTIFICATE-----\nnot-a-real-one\n-----END CERTIFICATE-----\n"
const CLIENT_CERTIFICATE = "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n"
const CLIENT_KEY = "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----\n"

let directory: string | null = null

function clientTlsFiles() {
  directory = mkdtempSync(join(tmpdir(), "trbot-ca-"))
  const caPath = join(directory, "ca.crt")
  const certPath = join(directory, "client.crt")
  const keyPath = join(directory, "client.key")
  writeFileSync(caPath, AUTHORITY)
  writeFileSync(certPath, CLIENT_CERTIFICATE)
  writeFileSync(keyPath, CLIENT_KEY)
  return { caPath, certPath, keyPath }
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = null
})

/**
 * The remote server and terminal mutually authenticate for both HTTP and the
 * WebSocket. Configuring either transport alone would make requests work while
 * leaving the terminal without live updates.
 *
 * The transport factory records the public constructor options, so this checks
 * the wiring without reaching into either client's private state.
 */
describe("reaching a server with mutual TLS", () => {
  test("the configured identity reaches both the requests and the socket", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "https://trbot.example:8443", token: "test-token", tls: clientTlsFiles() },
      transports: captured.transports,
    })

    const expected = { ca: AUTHORITY, cert: CLIENT_CERTIFICATE, key: CLIENT_KEY }
    expect(captured.httpOptions[0]?.tls).toEqual(expected)
    expect(captured.streamOptions[0]?.tls).toEqual(expected)

    session.close()
  })

  test("no configured TLS leaves both transports on plain HTTP", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "http://127.0.0.1:8080", token: "test-token", tls: null },
      transports: captured.transports,
    })

    expect(captured.httpOptions[0]?.tls).toBeNull()
    expect(captured.streamOptions[0]?.tls).toBeNull()

    session.close()
  })

  test("one ephemeral client identity reaches both transports", () => {
    const captured = captureTransports()
    const session = createServerSession({
      config: { url: "http://127.0.0.1:8080", token: "test-token", tls: null },
      transports: captured.transports,
    })

    const clientId = captured.httpOptions[0]?.clientId
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/)
    expect(captured.streamOptions[0]?.clientId).toBe(clientId)

    session.close()
  })

  // Failing here names the setting; failing later is a certificate error on
  // every request with nothing to say about why.
  test("a client certificate that cannot be read fails at startup, naming the setting", () => {
    expect(() =>
      createServerSession({
        config: {
          url: "https://trbot.example:8443",
          token: "test-token",
          tls: { caPath: null, certPath: "/nowhere/client.crt", keyPath: "/nowhere/client.key" },
        },
      }),
    ).toThrow(/TRBOT_CLIENT_TLS_CERT names \/nowhere\/client\.crt/)
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
    config: { url: "http://127.0.0.1:1", token: "test-token", tls: null },
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
