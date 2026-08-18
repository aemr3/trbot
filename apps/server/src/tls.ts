import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import * as x509 from "@peculiar/x509"
import { workspaceRoot } from "@trbot/config"

const CA_VALIDITY_DAYS = 3650
const SERVER_VALIDITY_DAYS = 397
const KEY_ALGORITHM: EcKeyGenParams & { hash: string } = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }

export interface CertificatePaths {
  caCert: string
  caKey: string
  serverCert: string
  serverKey: string
}

function certificatePaths(): CertificatePaths {
  const directory = resolve(workspaceRoot(), "data/tls")
  return {
    caCert: resolve(directory, "ca.crt"),
    caKey: resolve(directory, "ca.key"),
    serverCert: resolve(directory, "server.crt"),
    serverKey: resolve(directory, "server.key"),
  }
}

/**
 * Issues a server certificate for `hosts`, creating the authority on first use
 * and reusing it afterwards so clients that already trust it keep working.
 *
 * Certificates are generated here rather than shelled out to an external tool,
 * so provisioning behaves the same on every machine.
 */
export async function issueServerCertificate(hosts: string[]): Promise<CertificatePaths> {
  x509.cryptoProvider.set(crypto)
  const paths = certificatePaths()
  await mkdir(dirname(paths.caCert), { recursive: true, mode: 0o700 })

  const authority = await loadOrCreateAuthority(paths)
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])
  const names = hosts.length > 0 ? hosts : ["127.0.0.1", "localhost"]

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: `CN=${names[0]}`,
    issuer: authority.certificate.subject,
    notBefore: new Date(),
    notAfter: daysFromNow(SERVER_VALIDITY_DAYS),
    signingKey: authority.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: KEY_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(names.map((name) => ({ type: subjectType(name), value: name }))),
    ],
  })

  await writeSecret(paths.serverKey, await privateKeyPem(keys.privateKey))
  await writeFile(paths.serverCert, certificate.toString("pem"), { mode: 0o644 })
  return paths
}

/**
 * How long before expiry the server starts complaining.
 *
 * An expired certificate fails at connection time, from a process nobody is
 * watching, so the warning has to arrive well before that: this is enough
 * notice to reissue and restart at a convenient moment.
 */
export const RENEWAL_WARNING_DAYS = 30

export interface CertificateExpiry {
  notAfter: Date
  daysRemaining: number
  expired: boolean
  renewSoon: boolean
}

/**
 * Reads when a certificate stops being usable. Returns null when the file
 * cannot be read or parsed: an unreadable certificate is the TLS listener's
 * problem to report, not this check's.
 */
export async function certificateExpiry(path: string, now = new Date()): Promise<CertificateExpiry | null> {
  x509.cryptoProvider.set(crypto)
  let certificate: x509.X509Certificate
  try {
    certificate = new x509.X509Certificate(await Bun.file(path).text())
  } catch {
    return null
  }
  const notAfter = certificate.notAfter
  const daysRemaining = Math.floor((notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  return {
    notAfter,
    daysRemaining,
    expired: daysRemaining < 0,
    renewSoon: daysRemaining <= RENEWAL_WARNING_DAYS,
  }
}

interface Authority {
  certificate: x509.X509Certificate
  privateKey: CryptoKey
}

async function loadOrCreateAuthority(paths: CertificatePaths): Promise<Authority> {
  const certFile = Bun.file(paths.caCert)
  const keyFile = Bun.file(paths.caKey)

  if ((await certFile.exists()) && (await keyFile.exists())) {
    return {
      certificate: new x509.X509Certificate(await certFile.text()),
      privateKey: await importPrivateKey(await keyFile.text()),
    }
  }

  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: "CN=trbot local authority",
    notBefore: new Date(),
    notAfter: daysFromNow(CA_VALIDITY_DAYS),
    keys,
    signingAlgorithm: KEY_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  })

  await writeSecret(paths.caKey, await privateKeyPem(keys.privateKey))
  await writeFile(paths.caCert, certificate.toString("pem"), { mode: 0o644 })
  return { certificate, privateKey: keys.privateKey }
}

async function privateKeyPem(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("pkcs8", key)
  const body = Buffer.from(exported).toString("base64").replace(/(.{64})/g, "$1\n")
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")
  const bytes = Buffer.from(body, "base64")
  return crypto.subtle.importKey("pkcs8", bytes, KEY_ALGORITHM, true, ["sign"])
}

// Private keys are owner-only, matching how the database file is handled.
async function writeSecret(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 })
  await chmod(path, 0o600)
}

function subjectType(name: string): "ip" | "dns" {
  return /^[\d.]+$/.test(name) || name.includes(":") ? "ip" : "dns"
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function serialNumber(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")
}
