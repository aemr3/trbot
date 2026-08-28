import "reflect-metadata"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import * as x509 from "@peculiar/x509"
import { workspaceRoot } from "@trbot/config"

const CA_VALIDITY_DAYS = 3650
const CERTIFICATE_VALIDITY_DAYS = 397
const KEY_ALGORITHM: EcKeyGenParams & { hash: string } = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }

export interface CertificatePaths {
  caCert: string
  caKey: string
  serverCert: string
  serverKey: string
  clientCert: string
  clientKey: string
}

function certificatePaths(directory = resolve(workspaceRoot(), "data/tls")): CertificatePaths {
  return {
    caCert: resolve(directory, "ca.crt"),
    caKey: resolve(directory, "ca.key"),
    serverCert: resolve(directory, "server.crt"),
    serverKey: resolve(directory, "server.key"),
    clientCert: resolve(directory, "client.crt"),
    clientKey: resolve(directory, "client.key"),
  }
}

/**
 * Issues both sides of the mTLS connection, creating the authority on first
 * use and reusing it afterwards so existing installations keep trusting it.
 *
 * Certificates are generated here rather than shelled out to an external tool,
 * so provisioning behaves the same on every machine.
 */
export async function issueMutualTlsCertificates(hosts: string[], directory?: string): Promise<CertificatePaths> {
  x509.cryptoProvider.set(crypto)
  const paths = certificatePaths(directory)
  await mkdir(dirname(paths.caCert), { recursive: true, mode: 0o700 })

  const authority = await loadOrCreateAuthority(paths)
  const names = hosts.length > 0 ? hosts : ["127.0.0.1", "localhost"]
  await issueLeafCertificate({
    authority,
    subject: `CN=${names[0]}`,
    usage: x509.ExtendedKeyUsage.serverAuth,
    paths: { cert: paths.serverCert, key: paths.serverKey },
    subjectAlternativeNames: names,
  })
  await issueLeafCertificate({
    authority,
    subject: "CN=trbot client",
    usage: x509.ExtendedKeyUsage.clientAuth,
    paths: { cert: paths.clientCert, key: paths.clientKey },
  })
  return paths
}

interface LeafCertificateOptions {
  authority: Authority
  subject: string
  usage: string
  paths: { cert: string; key: string }
  subjectAlternativeNames?: string[]
}

async function issueLeafCertificate(options: LeafCertificateOptions): Promise<void> {
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])
  const alternativeNames = options.subjectAlternativeNames
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([options.usage]),
  ]
  if (alternativeNames) {
    extensions.push(
      new x509.SubjectAlternativeNameExtension(
        alternativeNames.map((name) => ({ type: subjectType(name), value: name })),
      ),
    )
  }

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: options.subject,
    issuer: options.authority.certificate.subject,
    notBefore: new Date(),
    notAfter: daysFromNow(CERTIFICATE_VALIDITY_DAYS),
    signingKey: options.authority.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: KEY_ALGORITHM,
    extensions,
  })

  await writeSecret(options.paths.key, await privateKeyPem(keys.privateKey))
  await writeFile(options.paths.cert, certificate.toString("pem"), { mode: 0o644 })
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
