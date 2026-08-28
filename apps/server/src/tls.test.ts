import "reflect-metadata"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as x509 from "@peculiar/x509"
import { RENEWAL_WARNING_DAYS, certificateExpiry, issueMutualTlsCertificates } from "./tls.ts"

const KEY_ALGORITHM: EcKeyGenParams & { hash: string } = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
const DAY_MS = 24 * 60 * 60 * 1000

const directory = await mkdtemp(join(tmpdir(), "trbot-tls-"))

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Writes a certificate whose validity ends `days` from `now`. */
async function certificateExpiringIn(days: number, name: string): Promise<string> {
  x509.cryptoProvider.set(crypto)
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=expiry-test",
    notBefore: new Date(Date.now() - DAY_MS),
    notAfter: new Date(Date.now() + days * DAY_MS),
    keys,
    signingAlgorithm: KEY_ALGORITHM,
  })
  const path = join(directory, name)
  await writeFile(path, certificate.toString("pem"))
  return path
}

// An expired certificate fails at connection time, in a process with nobody
// watching. Knowing how long is left is what makes the warning possible.
describe("certificate expiry", () => {
  test("a certificate with plenty of life left needs no attention", async () => {
    const path = await certificateExpiringIn(RENEWAL_WARNING_DAYS + 60, "healthy.crt")
    const expiry = await certificateExpiry(path)
    expect(expiry?.renewSoon).toBe(false)
    expect(expiry?.expired).toBe(false)
    expect(expiry?.daysRemaining).toBeGreaterThan(RENEWAL_WARNING_DAYS)
  })

  test("a certificate inside the warning window asks to be renewed", async () => {
    const path = await certificateExpiringIn(RENEWAL_WARNING_DAYS - 5, "expiring.crt")
    const expiry = await certificateExpiry(path)
    expect(expiry?.renewSoon).toBe(true)
    expect(expiry?.expired).toBe(false)
  })

  test("an expired certificate reports how long ago it lapsed", async () => {
    const path = await certificateExpiringIn(-3, "expired.crt")
    const expiry = await certificateExpiry(path)
    expect(expiry?.expired).toBe(true)
    expect(expiry?.renewSoon).toBe(true)
    expect(expiry?.daysRemaining).toBeLessThan(0)
  })

  test("an unreadable certificate is not this check's problem to report", async () => {
    expect(await certificateExpiry(join(directory, "missing.crt"))).toBeNull()
    await writeFile(join(directory, "garbage.crt"), "not a certificate")
    expect(await certificateExpiry(join(directory, "garbage.crt"))).toBeNull()
  })
})

test("the generated server rejects clients without its issued identity", async () => {
  const paths = await issueMutualTlsCertificates(["127.0.0.1"], join(directory, "mutual"))
  const ca = await Bun.file(paths.caCert).text()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert: Bun.file(paths.serverCert),
      key: Bun.file(paths.serverKey),
      ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    fetch: () => Response.json({ ok: true }),
  })

  try {
    const url = `https://127.0.0.1:${server.port}`
    const rejected = await fetch(url, { tls: { ca } }).catch((cause: unknown) => cause)
    expect(rejected).toBeInstanceOf(Error)

    const response = await fetch(url, {
      tls: {
        ca,
        cert: Bun.file(paths.clientCert),
        key: Bun.file(paths.clientKey),
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  } finally {
    await server.stop(true)
  }
})
